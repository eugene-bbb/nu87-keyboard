/*
  NU87 TinyDK Home + Key Mapping integration test
  Target: AMB25 / RTL8720DF, AmebaD core 3.1.9, ST7796S 480x320.
  The TFT stays on the verified PB18/PB20 GPIO-register software SPI path.
  No SPI0, DMA, or pinmux change is made here.

  Serial companion protocol (one LF-terminated ASCII record):
    TIME,HH,MM,WEEKDAY(0=Sun),DAY,MONTH(0=Jan)
    WX,clear|clouds|rain|snow,TEMP_C,CITY
    AI,claude|codex,disconnected|idle|thinking|done|error
*/
#include <Arduino.h>
#include <Adafruit_GFX.h>
#include <Preferences.h>
#include <BLEDevice.h>
extern "C" {
#include "gap_adv.h"
#include "gap_le.h"
}
#include "usagi_sprites.h"
#include "usagi_bubbles.h"
#include "ui_font_4bpp.h"
#include "ui_hangul_4bpp.h"

// PA7 is LOG_TX in this AMB25 variant. Runtime Serial must never be started
// when PA7 is used as GPIO; BLE UART carries companion records and diagnostics.
#define NU87_PA7_USE_BLE 1
#define NU87_RUNTIME_LOG_UART 0
#define NU87_ENABLE_ANIMATION 1  // Set 0 for PA7 + static Home/Keymap isolation.
#define NU87_ENABLE_BLE 1        // Set 0 only for the final BLE-isolation step.
#define NU87_BLE_STATIC_RANDOM 1 // 1: advertise with a per-board BLE static random address (see bleAddrApply); 0: factory public address.
#define NU87_DIAG_PA7_LED 0      // Set 1: red LED flips on every accepted PA7 press.
#define NU87_DIAG_HEARTBEAT_LED 0 // Set 1: green LED flips every 250 ms in loop().
void transportLog(const char *line);
#define LOGF(...) do { char logf_buffer[180]; snprintf(logf_buffer, sizeof(logf_buffer), __VA_ARGS__); transportLog(logf_buffer); } while (0)
#define NU87_DIAG_VERBOSE 0 // 1 re-enables per-paint/PERF logs (they compete with input logs for the BLE queue)
#define VLOGF(...) do { if (NU87_DIAG_VERBOSE) LOGF(__VA_ARGS__); } while (0)
void serviceRgb();

constexpr uint8_t PIN_TFT_DC = 4;                 // AMB25 D4 = physical PA30
constexpr uint8_t PIN_TFT_MOSI = PB18, PIN_TFT_SCK = PB20;
constexpr uint8_t PIN_LED_G = PA12, PIN_LED_R = PA13, PIN_LED_B = PA14;
constexpr uint8_t KEY_ROWS[3] = {PB1, PB2, PB23};
constexpr uint8_t KEY_COLS[3] = {PB22, PA27, PB3};
constexpr uint8_t PIN_ENC_CLK = PB19, PIN_ENC_DT = PB21, PIN_ENC_SW = PA28;

// LOG_TX is PA7 (AMB_D12). The boot ROM uses it before setup(); after boot we
// explicitly select GPIO input. Runtime LOG UART is disabled above.
#define PA7_SCREEN_BUTTON_SAFE 1
#if PA7_SCREEN_BUTTON_SAFE
constexpr uint8_t PIN_PA7_BUTTON = PA7;
constexpr uint32_t PA7_DEBOUNCE_MS = 25;
#endif

constexpr uint16_t rgb565(uint8_t r,uint8_t g,uint8_t b){return (uint16_t)(((r>>3)<<11)|((g>>2)<<5)|(b>>3));}
// Light product theme shared with the web editor (nu87-editor): F8F8F8 page, white cards, E5E5E5 hairlines, A8D8F0 selection, F2B5CC accent.
// *_TX are darker tints of sky/pink for TEXT on light backgrounds. UI_STAGE is the dark stage the Usagi ASCII art was designed for.
constexpr uint16_t UI_BG=rgb565(248,248,248), UI_SURFACE=rgb565(255,255,255), UI_WHITE=rgb565(34,34,34) /*primary text*/,
                   UI_GRAY=rgb565(102,102,102), UI_DIM=rgb565(133,133,133), UI_PINK=rgb565(242,181,204), UI_SKY=rgb565(168,216,240),
                   UI_LINE=rgb565(229,229,229), UI_SEG=rgb565(236,236,236), UI_SELBG=rgb565(236,246,252), UI_STAGE=rgb565(8,10,16),
                   UI_PINK_TX=rgb565(155,63,101), UI_SKY_TX=rgb565(42,106,142);
constexpr uint32_t KEY_SCAN_INTERVAL_MS=1, KEY_DEBOUNCE_MS=25, ENC_DEBOUNCE_MS=25;
constexpr uint32_t ENC_LONG_PRESS_MS=850, HOLD_MS=450, DOUBLE_MS=300, TOAST_MS=1800;

void serviceInputsDuringTftTransfer();
bool renderAborted(); // true while a PA7 press is pending: LCD jobs stop at the next chunk boundary

struct UiFont{uint8_t cw,ch;const uint8_t *data,*adv,*hg;}; // hg: Hangul glyph block (SM/MD only)
const UiFont F_SM={UI_SM_CW,UI_SM_CH,UI_SM_4BPP,UI_SM_ADV,UI_SM_HANGUL},F_MD={UI_MD_CW,UI_MD_CH,UI_MD_4BPP,UI_MD_ADV,UI_MD_HANGUL},F_LG={UI_LG_CW,UI_LG_CH,UI_LG_4BPP,UI_LG_ADV,nullptr},F_XL={UI_XL_CW,UI_XL_CH,UI_XL_4BPP,UI_XL_ADV,nullptr};
class ST7796SoftSPI : public Adafruit_GFX {
 public:
  ST7796SoftSPI():Adafruit_GFX(480,320) {}
  void begin() {
    pinMode(PIN_TFT_MOSI,OUTPUT); pinMode(PIN_TFT_SCK,OUTPUT); pinMode(PIN_TFT_DC,OUTPUT);
    digitalWrite(PIN_TFT_SCK,LOW); digitalWrite(PIN_TFT_MOSI,LOW); digitalWrite(PIN_TFT_DC,HIGH);
    port_=portOutputRegister(digitalPinToPort(PIN_TFT_SCK)); dcPort_=portOutputRegister(digitalPinToPort(PIN_TFT_DC));
    mosiMask_=digitalPinToBitMask(PIN_TFT_MOSI); sckMask_=digitalPinToBitMask(PIN_TFT_SCK); dcMask_=digitalPinToBitMask(PIN_TFT_DC);
    delay(120); command(0x01); delay(150); command1(0xF0,0xC3); command1(0xF0,0x96); command1(0x36,0x28); command1(0x3A,0x55);
    command1(0xB4,0x01); command1(0xB7,0xC6); static const uint8_t d[]={0x02,0x02,0x3B}; command(0xB6,d,3);
    command1(0xC0,0x80); command1(0xC1,0x13); command1(0xC2,0xA7); command1(0xC5,0x18);
    static const uint8_t gp[]={0xF0,0x09,0x0B,0x06,0x04,0x15,0x2F,0x54,0x42,0x3C,0x17,0x14,0x18,0x1B};
    static const uint8_t gn[]={0xE0,0x09,0x0B,0x06,0x04,0x03,0x2B,0x43,0x42,0x3B,0x16,0x14,0x17,0x1B};
    command(0xE0,gp,sizeof(gp)); command(0xE1,gn,sizeof(gn)); command(0x11); delay(120); command(0x29); delay(20);
  }
  void startWrite() override {} void endWrite() override {}
  void drawPixel(int16_t x,int16_t y,uint16_t c) override { if(!renderAborted()&&x>=0&&y>=0&&x<480&&y<320){setWindow(x,y,x,y);writeColor(c,1);} }
  void writePixel(int16_t x,int16_t y,uint16_t c) override { drawPixel(x,y,c); }
  void writeFillRect(int16_t x,int16_t y,int16_t w,int16_t h,uint16_t c) override { if(w<=0||h<=0||x>=480||y>=320||renderAborted())return; if(x<0){w+=x;x=0;}if(y<0){h+=y;y=0;}if(x+w>480)w=480-x;if(y+h>320)h=320-y;if(w>0&&h>0){setWindow(x,y,x+w-1,y+h-1);writeColor(c,(uint32_t)w*h);} }
  void fillRect(int16_t x,int16_t y,int16_t w,int16_t h,uint16_t c) override { writeFillRect(x,y,w,h,c); }
  void fillScreen(uint16_t c) override { fillRect(0,0,480,320,c); }
  uint32_t wireBytes() const { return wireBytes_; }
  uint32_t windowCount() const { return windowCount_; }
  uint32_t uiPrepUs() const { return uiPrepUs_; }
  // One RLE+palette illustration into its fixed canvas (setWindow once). Returns false if a newer PA7 request / gesture aborted it.
  bool drawSprite(int16_t x,int16_t y,uint8_t id) {
    if(renderAborted()||id>=SPRITE_COUNT)return false;
    uint16_t pal[64]; for(uint8_t i=0;i<64;i++)pal[i]=pgm_read_word(&SPRITE_PAL[id][i]);
    uint32_t p=pgm_read_dword(&SPRITE_OFF[id]),left=(uint32_t)SPRITE_W*SPRITE_H; uint16_t s=512;
    setWindow(x,y,x+SPRITE_W-1,y+SPRITE_H-1);
    while(left){uint8_t run=pgm_read_byte(&SPRITE_DATA[p++]);uint16_t c=pal[pgm_read_byte(&SPRITE_DATA[p++])&63];if(run>left)run=left;left-=run;
      while(run--){byteOut(c>>8);byteOut(c);if(!--s){serviceInputsDuringTftTransfer();s=512;if(renderAborted())return false;}}}
    return true;
  }
  // Pre-rasterised speech-bubble shell (RLE + palette, composited on the Home background): one window, abortable like drawSprite.
  bool drawBubbleAsset(int16_t x,int16_t y,uint8_t id) {
    if(renderAborted()||id>=BUB_COUNT)return false;
    uint16_t pal[32]; for(uint8_t i=0;i<32;i++)pal[i]=pgm_read_word(&BUB_PAL[id][i]);
    uint8_t w=pgm_read_byte(&BUB_W[id]),h=pgm_read_byte(&BUB_H[id]);uint32_t p=pgm_read_dword(&BUB_OFF[id]),left=(uint32_t)w*h;uint16_t s=512;
    setWindow(x,y,x+w-1,y+h-1);
    while(left){uint8_t run=pgm_read_byte(&BUB_DATA[p++]);uint16_t c=pal[pgm_read_byte(&BUB_DATA[p++])&31];if(run>left)run=left;left-=run;
      while(run--){byteOut(c>>8);byteOut(c);if(!--s){serviceInputsDuringTftTransfer();s=512;if(renderAborted())return false;}}}
    return true;
  }
  // Proportional packed 4-bpp alpha glyphs (tools_make_ui_font.py). Returns drawn width;
  // text is truncated at maxX so a window can never wrap outside the panel.
  // UTF-8 in, Pretendard glyphs out: ASCII, degree/middle dot, and KS X 1001 Hangul in SM/MD (anything else -> '?').
  static int utf8Next(const char *&s){uint8_t c=(uint8_t)*s++;if(c<0x80)return c;if((c&0xE0)==0xC0&&((uint8_t)s[0]&0xC0)==0x80){int cp=((c&0x1F)<<6)|(s[0]&0x3F);s++;return cp;}if((c&0xF0)==0xE0&&((uint8_t)s[0]&0xC0)==0x80&&((uint8_t)s[1]&0xC0)==0x80){int cp=((c&0x0F)<<12)|((s[0]&0x3F)<<6)|(s[1]&0x3F);s+=2;return cp;}if(c==0xB0)return 176;if(c==0xB7)return 183;while(((uint8_t)*s&0xC0)==0x80)s++;return 63;}
  static int hangulIndex(int cp){int lo=0,hi=UI_HANGUL_N-1;while(lo<=hi){int m=(lo+hi)>>1;int v=pgm_read_word(&UI_HANGUL_CP[m]);if(v==cp)return m;if(v<cp)lo=m+1;else hi=m-1;}return -1;}
  static const uint8_t *glyphOf(int cp,const UiFont &f,uint8_t &adv){
    const uint16_t cellBytes=(f.cw*f.ch+1)/2;
    if(cp>=0xAC00&&cp<=0xD7A3&&f.hg){int k=hangulIndex(cp);if(k>=0){adv=f.cw;return f.hg+(uint32_t)k*cellBytes;}cp=63;}
    uint8_t gi=cp==176?95:cp==183?96:(cp>=32&&cp<=126)?cp-32:31;adv=pgm_read_byte(&f.adv[gi]);return f.data+(uint32_t)gi*cellBytes;}
  int textWidth(const char *s,const UiFont &f){int w=0;while(*s){int cp=utf8Next(s);uint8_t a;glyphOf(cp,f,a);w+=a;}return w;}
  int uiText(int16_t x,int16_t y,const char *s,const UiFont &f,uint16_t fg,uint16_t bg=UI_BG,int16_t maxX=480) {
    if(renderAborted())return 0; if(maxX>480)maxX=480; if(x<0||y<0||y+f.ch>320||!*s)return 0;
    const uint8_t *gp[40];uint8_t ga[40];uint8_t n=0;int w=0;
    while(*s&&n<40){int cp=utf8Next(s);uint8_t a;const uint8_t *g=glyphOf(cp,f,a);if(x+w+a>maxX)break;gp[n]=g;ga[n]=a;n++;w+=a;} if(!n)return 0;
    uint32_t prepStarted=micros();
    uint16_t lut[16]; for(uint8_t i=0;i<16;i++){uint8_t fr=(fg>>11)*255/31, fgc=((fg>>5)&63)*255/63, fb=(fg&31)*255/31, br=(bg>>11)*255/31,bgc=((bg>>5)&63)*255/63,bb=(bg&31)*255/31; uint8_t r=br+(int16_t)(fr-br)*i/15,g=bgc+(int16_t)(fgc-bgc)*i/15,b=bb+(int16_t)(fb-bb)*i/15;lut[i]=((r>>3)<<11)|((g>>2)<<5)|(b>>3);}
    uiPrepUs_+=micros()-prepStarted;
    setWindow(x,y,x+w-1,y+f.ch-1); uint16_t service=512; const uint16_t cellBytes=(f.cw*f.ch+1)/2;
    for(uint8_t py=0;py<f.ch;py++)for(uint8_t q=0;q<n;q++){uint8_t a=ga[q];const uint8_t *g=gp[q];for(uint8_t px=0;px<a;px++){uint16_t o=py*f.cw+px;uint8_t p=pgm_read_byte(&g[o>>1]);uint16_t v=lut[(o&1)?p&15:p>>4];byteOut(v>>8);byteOut(v);if(!--service){serviceInputsDuringTftTransfer();service=512;if(renderAborted())return w;}}}
    return w;
  }
 private:
  volatile uint32_t *port_=nullptr,*dcPort_=nullptr; uint32_t mosiMask_=0,sckMask_=0,dcMask_=0,wireBytes_=0,windowCount_=0,uiPrepUs_=0; uint8_t rgbServiceDivider_=0;
  inline __attribute__((always_inline)) void dcLow(){*dcPort_&=~dcMask_;} inline __attribute__((always_inline)) void dcHigh(){*dcPort_|=dcMask_;}
  inline __attribute__((always_inline)) void byteOut(uint8_t v){wireBytes_++;const uint32_t b=*port_&~(mosiMask_|sckMask_);uint32_t d=b|((v&0x80)?mosiMask_:0);for(uint8_t m=0x80;m;m>>=1){*port_=d;*port_=d|sckMask_;if(m!=1)d=b|((v&(m>>1))?mosiMask_:0);}*port_=d;if(++rgbServiceDivider_==32){rgbServiceDivider_=0;serviceRgb();}}
  void command(uint8_t c,const uint8_t *d=nullptr,uint8_t n=0){dcLow();byteOut(c);dcHigh();while(n--)byteOut(*d++);} void command1(uint8_t c,uint8_t v){command(c,&v,1);}
  void setWindow(uint16_t x0,uint16_t y0,uint16_t x1,uint16_t y1){windowCount_++;dcLow();byteOut(0x2A);dcHigh();byteOut(x0>>8);byteOut(x0);byteOut(x1>>8);byteOut(x1);dcLow();byteOut(0x2B);dcHigh();byteOut(y0>>8);byteOut(y0);byteOut(y1>>8);byteOut(y1);dcLow();byteOut(0x2C);dcHigh();}
  void writeColor(uint16_t c,uint32_t n){uint16_t s=512;while(n--){byteOut(c>>8);byteOut(c);if(!--s){serviceInputsDuringTftTransfer();s=512;if(renderAborted())return;}}}
};
ST7796SoftSPI tft;

// Nordic UART Service UUIDs: a Mac central can use the same newline-delimited
// TIME/WX/AI records as the old USB serial transport. TX also carries logs.
constexpr char BLE_UART_SERVICE[] = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char BLE_UART_RX[]      = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char BLE_UART_TX[]      = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
BLEService bleService(BLE_UART_SERVICE); BLECharacteristic bleRx(BLE_UART_RX), bleTx(BLE_UART_TX);
BLEAdvertData bleAdv, bleScan; bool bleNotify=false, bleReady=false;
char bleAddrLine[64]="BLE_ADDR PUBLIC"; // sent once when a central enables notifications
void bleAddrPrepare(); void bleAddrApply();
bool pendingLcdBench=false;
void parseCompanion(char *p); bool cfgHandleLine(char *s); bool notifHandleLine(char *s); bool aiHandleLine(char *s); bool lunchHandleLine(char *s); bool gptHandleLine(char *s); bool toastHandleLine(char *s); bool clockWxHandleLine(char *s);
void bleWrite(BLECharacteristic *chr,uint8_t){ char line[80]; size_t n=chr->getDataLen(); if(n>=sizeof(line))return; chr->getData((uint8_t*)line,n); line[n]=0;if(cfgHandleLine(line)||notifHandleLine(line)||aiHandleLine(line)||lunchHandleLine(line)||gptHandleLine(line)||toastHandleLine(line)||clockWxHandleLine(line))return;if(!strcmp(line,"BENCH")||!strcmp(line,"BENCH\n")){pendingLcdBench=true;return;}parseCompanion(line); }
void bleCccd(BLECharacteristic*,uint8_t,uint16_t cccd){bleNotify=(cccd&GATT_CLIENT_CHAR_CONFIG_NOTIFY)!=0;if(bleNotify)transportLog(bleAddrLine);}
char diagnosticQueue[16][96];uint8_t diagnosticHead=0,diagnosticTail=0;
void transportLog(const char *line){uint8_t next=(diagnosticHead+1)&15;if(next==diagnosticTail)return;strncpy(diagnosticQueue[diagnosticHead],line,95);diagnosticQueue[diagnosticHead][95]=0;diagnosticHead=next;}
// Structured PC events: only queued while a central has notifications enabled, never replayed after a reconnect.
bool bleSendLine(const char *line){if(!(bleReady&&bleNotify&&BLE.connected(0)))return false;uint8_t next=(diagnosticHead+1)&15;if(next==diagnosticTail)return false;strncpy(diagnosticQueue[diagnosticHead],line,95);diagnosticQueue[diagnosticHead][95]=0;diagnosticHead=next;return true;}
// Web-settings sync: cfgRev bumps on every persisted settings change; the Mac bridge is told (CCHG) unless the change came from the bridge itself.
uint8_t cfgRev=0; bool cfgHostCommit=false;
void cfgChanged(){cfgRev++;if(!cfgHostCommit){char b[16];snprintf(b,sizeof(b),"CCHG|%u\n",(unsigned)cfgRev);bleSendLine(b);}}
void flushDiagnostic(){if(diagnosticTail==diagnosticHead)return;if(bleReady&&bleNotify&&BLE.connected(0)){bleTx.writeString(diagnosticQueue[diagnosticTail]);bleTx.notify(0);}diagnosticTail=(diagnosticTail+1)&15;}
void beginBle(){
  bleAdv.addFlags(GAP_ADTYPE_FLAGS_LIMITED|GAP_ADTYPE_FLAGS_BREDR_NOT_SUPPORTED);bleAdv.addCompleteName("NU87 Usagi");bleScan.addCompleteServices(BLEUUID(BLE_UART_SERVICE));
  bleRx.setWriteProperty(true);bleRx.setWritePermissions(GATT_PERM_WRITE);bleRx.setWriteCallback(bleWrite);bleRx.setBufferLen(100);
  bleTx.setReadProperty(true);bleTx.setReadPermissions(GATT_PERM_READ);bleTx.setNotifyProperty(true);bleTx.setCCCDCallback(bleCccd);bleTx.setBufferLen(180);
  bleService.addCharacteristic(bleRx);bleService.addCharacteristic(bleTx);BLE.init();BLE.configAdvert()->setAdvData(bleAdv);BLE.configAdvert()->setScanRspData(bleScan);BLE.configServer(1);BLE.addService(bleService);bleAddrPrepare();BLE.beginPeripheral();bleAddrApply();bleReady=true;
}

// ── Input scanner (lifted from the verified encoder/9-key sketch) ──────────
volatile uint8_t encoderState=0; volatile int8_t encoderQuarter=0; volatile int16_t encoderDetents=0;
constexpr int8_t QUAD[16]={0,-1,1,0,1,0,0,-1,-1,0,0,1,0,1,-1,0};
uint8_t matrixRow=0; uint16_t matrixFrame=0,candidateKeys=0,stableKeys=0,pendingDown=0,pendingUp=0; uint32_t candidateAt=0,lastMatrixAt=0;
struct Rgb8{uint8_t r,g,b;};
constexpr Rgb8 KEY_RGB[9]={{255,0,0},{255,64,0},{255,255,0},{0,255,0},{0,0,255},{20,0,74},{0,255,255},{255,0,80},{255,255,255}};
constexpr uint8_t MAX_LED_LEVEL=96;
uint8_t rgbR=0,rgbG=0,rgbB=0; bool rgbOutR=false,rgbOutG=false,rgbOutB=false;
uint8_t limitedLed(uint8_t v){return ((uint16_t)v*MAX_LED_LEVEL+127U)/255U;}
// RGB settings are persisted separately from key bindings.  The switch colour
// path remains the verified active-HIGH, MAX_LED_LEVEL=96 implementation.
enum RgbEffect:uint8_t { RGB_OFF, RGB_STATIC, RGB_BREATHING, RGB_PASTEL_CYCLE };
enum RgbColor:uint8_t { RGB_WHITE, RGB_PINK, RGB_SKY, RGB_CUSTOM };
struct RgbConfig { uint8_t version,effect,color,brightness,speed10,customR,customG,customB; uint16_t crc; } __attribute__((packed));
// customR holds the Custom hue in 2-degree steps (0..179); customG/customB are reserved.
RgbConfig rgbConfig={1,RGB_BREATHING,RGB_PINK,35,20,100,0,0,0};
RgbConfig rgbDraft=rgbConfig; bool rgbEditing=false;
bool rgbPreviewActive=false;
RgbConfig *activeRgbConfig(){return rgbPreviewActive?&rgbDraft:&rgbConfig;}
void hueToRgb(uint16_t deg,uint8_t &r,uint8_t &g,uint8_t &b){
  deg%=360; uint8_t sec=deg/60; uint16_t f=(deg%60)*255U/60U; const uint16_t s=150;
  uint8_t p=255-s, q=255-s*f/255U, t=255-s*(255U-f)/255U;
  switch(sec){case 0:r=255;g=t;b=p;break;case 1:r=q;g=255;b=p;break;case 2:r=p;g=255;b=t;break;case 3:r=p;g=q;b=255;break;case 4:r=t;g=p;b=255;break;default:r=255;g=p;b=q;}
}
void rgbBaseColor(uint8_t color,uint8_t &r,uint8_t &g,uint8_t &b){
  if(color==RGB_PINK){r=255;g=170;b=205;}else if(color==RGB_SKY){r=155;g=215;b=255;}
  else if(color==RGB_CUSTOM){hueToRgb((uint16_t)activeRgbConfig()->customR*2U,r,g,b);}
  else {r=g=b=255;}
}
void ambientRgbLevels(uint8_t &r,uint8_t &g,uint8_t &b){
  RgbConfig &cfg=*activeRgbConfig(); uint8_t br=cfg.brightness;
  if(cfg.effect==RGB_OFF||br==0){r=g=b=0;return;}
  uint8_t cr=255,cg=255,cb=255; rgbBaseColor(cfg.color,cr,cg,cb);
  uint16_t factor=255;
  if(cfg.effect==RGB_BREATHING){
    uint32_t period=(uint32_t)cfg.speed10*100U; uint16_t phase=(millis()%period)*255U/period;
    uint16_t x=phase<128?phase*2U:(255U-phase)*2U; uint16_t ease=(x*x*(uint32_t)(767U-2U*x))/65025U;
    factor=24U+(uint32_t)ease*231U/255U;
  }else if(cfg.effect==RGB_PASTEL_CYCLE){
    static const Rgb8 palette[]={{255,190,215},{175,220,255},{205,185,245},{175,245,210}};
    uint32_t period=(uint32_t)cfg.speed10*100U; uint16_t phase=(millis()%period)*4U*256U/period;
    uint8_t seg=(phase>>8)&3, f=phase&255; const Rgb8 &a=palette[seg],&z=palette[(seg+1)&3];
    cr=a.r+((int16_t)z.r-a.r)*f/255; cg=a.g+((int16_t)z.g-a.g)*f/255; cb=a.b+((int16_t)z.b-a.b)*f/255;
  }
  r=limitedLed((uint8_t)((uint16_t)cr*br*factor/(100U*255U)));
  g=limitedLed((uint8_t)((uint16_t)cg*br*factor/(100U*255U)));
  b=limitedLed((uint8_t)((uint16_t)cb*br*factor/(100U*255U)));
}
void setRgbForKeys(uint16_t keys){int8_t k=-1;for(uint8_t i=0;i<9;i++)if(keys&(1U<<i)){k=i;break;}if(k<0){ambientRgbLevels(rgbR,rgbG,rgbB);}else{rgbR=limitedLed(KEY_RGB[k].r);rgbG=limitedLed(KEY_RGB[k].g);rgbB=limitedLed(KEY_RGB[k].b);}serviceRgb();}
void serviceRgb(){static uint32_t lastAmbientMs=0;if(stableKeys==0){uint32_t now=millis();if(now-lastAmbientMs>=5){lastAmbientMs=now;ambientRgbLevels(rgbR,rgbG,rgbB);}}uint8_t phase=(uint8_t)((micros()/20U)&0xFFU);bool r=phase<rgbR,g=phase<rgbG,b=phase<rgbB;if(r!=rgbOutR){rgbOutR=r;digitalWrite(PIN_LED_R,r?HIGH:LOW);}if(g!=rgbOutG){rgbOutG=g;digitalWrite(PIN_LED_G,g?HIGH:LOW);}if(b!=rgbOutB){rgbOutB=b;digitalWrite(PIN_LED_B,b?HIGH:LOW);}}
bool rawEnc=HIGH,stableEnc=HIGH,encLongSent=false,pendingClick=false,pendingLong=false,inputReady=false; uint32_t encChangedAt=0,encDownAt=0; int16_t pendingDetents=0;
#if PA7_SCREEN_BUTTON_SAFE
bool rawPa7=HIGH,stablePa7=HIGH; volatile bool pendingPa7=false; uint32_t pa7ChangedAt=0,pa7AcceptedUs=0;
#endif
void encoderISR(){uint8_t c=(digitalRead(PIN_ENC_CLK)<<1)|digitalRead(PIN_ENC_DT);if(c==encoderState)return;encoderQuarter+=QUAD[(encoderState<<2)|c];encoderState=c;if(encoderQuarter>=4){encoderDetents++;encoderQuarter=0;}else if(encoderQuarter<=-4){encoderDetents--;encoderQuarter=0;}}
// Debounced key edges are queued with their own (debounce-start) timestamp so Single/Double/Hold
// timing is independent of how long the main loop was busy drawing.
struct KeyEdge{uint8_t key;bool down;uint32_t t;}; KeyEdge edgeQ[32];uint8_t edgeHead=0,edgeTail=0;
void pushEdge(uint8_t k,bool down,uint32_t t){uint8_t n=(edgeHead+1)&31;if(n==edgeTail)return;edgeQ[edgeHead]={k,down,t};edgeHead=n;}
void releaseRows(){for(uint8_t r=0;r<3;r++)pinMode(KEY_ROWS[r],INPUT_PULLUP);}
void acceptFrame(uint16_t s,uint32_t now){if(s!=candidateKeys){candidateKeys=s;candidateAt=now;return;}if(s!=stableKeys&&now-candidateAt>=KEY_DEBOUNCE_MS){uint16_t ch=s^stableKeys;for(uint8_t k=0;k<9;k++)if(ch&(1U<<k))pushEdge(k,(s&(1U<<k))!=0,candidateAt);stableKeys=s;setRgbForKeys(stableKeys);}}
void serviceMatrix(uint32_t now){if(now-lastMatrixAt<KEY_SCAN_INTERVAL_MS)return;lastMatrixAt=now;releaseRows();digitalWrite(KEY_ROWS[matrixRow],LOW);pinMode(KEY_ROWS[matrixRow],OUTPUT);for(uint8_t c=0;c<3;c++)if(digitalRead(KEY_COLS[c])==LOW)matrixFrame|=1U<<(matrixRow*3+c);pinMode(KEY_ROWS[matrixRow],INPUT_PULLUP);if(++matrixRow==3){matrixRow=0;uint16_t f=matrixFrame;matrixFrame=0;acceptFrame(f,now);}}
void serviceEncoder(uint32_t now){noInterrupts();int16_t d=encoderDetents;encoderDetents=0;interrupts();pendingDetents+=d;bool r=digitalRead(PIN_ENC_SW);if(r!=rawEnc){rawEnc=r;encChangedAt=now;}if(r!=stableEnc&&now-encChangedAt>=ENC_DEBOUNCE_MS){stableEnc=r;if(r==LOW){encDownAt=now;encLongSent=false;}else if(!encLongSent)pendingClick=true;}if(stableEnc==LOW&&!encLongSent&&now-encDownAt>=ENC_LONG_PRESS_MS){encLongSent=true;pendingLong=true;}}
#if PA7_SCREEN_BUTTON_SAFE
void servicePa7(uint32_t now){bool r=digitalRead(PIN_PA7_BUTTON);if(r!=rawPa7){rawPa7=r;pa7ChangedAt=now;}if(r!=stablePa7&&now-pa7ChangedAt>=PA7_DEBOUNCE_MS){stablePa7=r;if(r==LOW){pendingPa7=true;pa7AcceptedUs=micros();}}}
#endif
// This runs inside long GPIO-SPI bursts. PA7 was missing here while the
// matrix/encoder were serviced, so a normal short press could be missed while
// the first Usagi keyframe was being pushed to the LCD.
void serviceGestures(uint32_t now);
void serviceInputsDuringTftTransfer(){if(!inputReady)return;uint32_t n=millis();
#if PA7_SCREEN_BUTTON_SAFE
  servicePa7(n);
#endif
  serviceMatrix(n);serviceEncoder(n);serviceGestures(n);serviceRgb();flushDiagnostic();yield();} // BLE lines (requests, EVT) must not wait for a multi-second LCD job

// ── Browser config model, persisted only on confirmed save ────────────────
enum InputType:uint8_t { SINGLE, DOUBLE, HOLD }; enum Stage:uint8_t { KM_KEY, KM_INPUT, KM_ACTION, KM_CONFIRM }; enum Screen:uint8_t { HOME, KEYMAP, RGB_SETTINGS, LUNCH, GPT_MODE, AI_ACT };
struct Binding { uint8_t v[3]; }; struct Persist { uint32_t magic; uint8_t version,active; Binding keys[2][9]; uint16_t crc; } __attribute__((packed));
constexpr uint32_t CONFIG_MAGIC=0x4E553837UL; constexpr uint8_t CONFIG_VERSION=1; Preferences prefs; Persist config;
const char *PROFILE[2]={"Dev","Media"}; const uint8_t DEFAULTS[2][9][3]={{{1,0,0},{2,0,0},{3,0,4},{10,0,0},{11,0,0},{12,0,0},{13,0,0},{40,41,0},{20,0,30}},{{22,0,0},{20,0,0},{21,0,0},{23,0,0},{10,0,0},{11,0,0},{1,0,0},{41,40,0},{31,0,30}}};
uint16_t crc16(const uint8_t *p,size_t n){uint16_t c=0xFFFF;while(n--){c^=*p++;for(uint8_t b=0;b<8;b++)c=(c&1)?(c>>1)^0xA001:c>>1;}return c;}
void resetConfig(){memset(&config,0,sizeof(config));config.magic=CONFIG_MAGIC;config.version=CONFIG_VERSION;for(uint8_t p=0;p<2;p++)for(uint8_t k=0;k<9;k++)for(uint8_t i=0;i<3;i++)config.keys[p][k].v[i]=DEFAULTS[p][k][i];}
bool saveConfig(){config.crc=crc16((uint8_t*)&config,sizeof(config)-2);prefs.begin("nu87-ui");size_t n=prefs.putBytes("keymap",&config,sizeof(config));prefs.end();cfgChanged();LOGF("NVM_SAVE bytes=%u ok=%u\n",(unsigned)n,n==sizeof(config));return n==sizeof(config);}
void loadConfig(){Persist p;prefs.begin("nu87-ui",true);size_t n=prefs.getBytes("keymap",&p,sizeof(p));prefs.end();if(n==sizeof(p)&&p.magic==CONFIG_MAGIC&&p.version==CONFIG_VERSION&&p.active<2&&p.crc==crc16((uint8_t*)&p,sizeof(p)-2)){config=p;}else resetConfig();}

// ── Knob (KY-040) mapping: 6 modes x slots {CW, CCW, CLICK, HOLD}, Action IDs shared with the 9 keys ──
constexpr uint8_t KNOB_MODES=6,KNOB_SLOTS=4,KNOB_KEY=9; // KNOB_KEY = pseudo key index used by the Key Mapping screen
const char* const KNOB_MODE_NAME[6]={"Volume","Media","Brightness","Reasoning","Scroll","Custom"};
const char* const KNOB_MODE_TILE[6]={"Volume","Media","Bright","Reason","Scroll","Custom"};
const char* const KNOB_SLOT_NAME[4]={"CW","CCW","CLICK","HOLD"};
// Defaults. Slot HOLD = 60 (Next Knob Mode) in every mode, so Long Press cycles modes but can be reassigned.
const uint8_t KNOB_DEFAULTS[6][4]={{50,51,23,60},{21,22,20,60},{52,53,0,60},{54,55,56,60},{57,58,0,60},{0,0,0,60}};
struct KnobCfg{uint32_t magic;uint8_t version,mode;uint8_t map[6][4];uint16_t crc;} __attribute__((packed)); KnobCfg knob;
bool knobModeEdit=false;uint8_t knobModeOld=0;
void resetKnob(){memset(&knob,0,sizeof(knob));knob.magic=0x4B4E4F42UL;knob.version=1;memcpy(knob.map,KNOB_DEFAULTS,sizeof(knob.map));}
bool saveKnob(){knob.crc=crc16((uint8_t*)&knob,sizeof(knob)-2);prefs.begin("nu87-ui");size_t n=prefs.putBytes("knob",&knob,sizeof(knob));prefs.end();cfgChanged();LOGF("KNOB_SAVE mode=%u ok=%u\n",knob.mode,n==sizeof(knob));return n==sizeof(knob);}
void loadKnob(){KnobCfg p;prefs.begin("nu87-ui",true);size_t n=prefs.getBytes("knob",&p,sizeof(p));prefs.end();if(n==sizeof(p)&&p.magic==0x4B4E4F42UL&&p.version==1&&p.mode<KNOB_MODES&&p.crc==crc16((uint8_t*)&p,sizeof(p)-2))knob=p;else resetKnob();}

// ── BLE static random address ─────────────────────────────────────────────
// The factory (public) BD_ADDR can be identical on several RTL8720DF boards, so two boards then look like one device to a Mac.
// The Ameba BLE library always advertises with the controller's public address, so after the stack is ready we (1) generate a
// static random address ONCE and keep it in Preferences ("bleaddr"), (2) program it with le_set_rand_addr, (3) switch the advertising
// local-address type to RANDOM and restart advertising. eFuse / Wi-Fi MAC / bootloader are never touched. If anything fails the
// code falls back to the public address so BLE still works.
struct BleAddrStore{uint32_t magic;uint8_t addr[6];uint16_t crc;} __attribute__((packed));
bool staticRandomValid(const uint8_t *a){ // addr[5] is the most significant byte (Realtek stores little-endian)
  if((a[5]&0xC0)!=0xC0)return false; bool ones=(a[5]&0x3F)==0x3F,zeros=(a[5]&0x3F)==0;for(uint8_t i=0;i<5;i++){ones&=a[i]==0xFF;zeros&=a[i]==0;}return !ones&&!zeros;}
void bleAddrPrepare(){
#if NU87_BLE_STATIC_RANDOM
  uint8_t t=GAP_LOCAL_ADDR_LE_RANDOM;le_adv_set_param(GAP_PARAM_ADV_LOCAL_ADDR_TYPE,sizeof(t),&t); // stored before the stack starts so its first advertisement is not public
#endif
}
void bleAddrApply(){
#if NU87_BLE_STATIC_RANDOM
  BleAddrStore st;bool have=false,created=false;
  prefs.begin("nu87-ui",true);size_t n=prefs.getBytes("bleaddr",&st,sizeof(st));prefs.end();
  have=n==sizeof(st)&&st.magic==0x42415452UL&&st.crc==crc16((uint8_t*)&st,sizeof(st)-2)&&staticRandomValid(st.addr);
  if(!have){ // first boot (or invalid blob): create once
    memset(&st,0,sizeof(st));st.magic=0x42415452UL;
    if(le_gen_rand_addr(GAP_RAND_ADDR_STATIC,st.addr)!=GAP_SUCCESS||!staticRandomValid(st.addr)){uint32_t m=micros()*2654435761UL^millis()*40503UL;for(uint8_t i=0;i<6;i++){m=m*1664525UL+1013904223UL+analogRead(A0);st.addr[i]=m>>24;}st.addr[5]|=0xC0;}
    uint8_t pub[GAP_BD_ADDR_LEN];BLE.getLocalAddr(pub);if(!memcmp(pub,st.addr,6))st.addr[0]^=0x5A; // never equal to the factory address
    if(!staticRandomValid(st.addr))st.addr[5]|=0xC0,st.addr[0]|=1;
    st.crc=crc16((uint8_t*)&st,sizeof(st)-2);prefs.begin("nu87-ui");prefs.putBytes("bleaddr",&st,sizeof(st));prefs.end();created=true;
  }
  bool ok=false;T_GAP_CAUSE cause=GAP_CAUSE_SUCCESS;
  for(uint8_t attempt=0;attempt<3&&!ok;attempt++){
    le_adv_stop();delay(60);cause=le_set_rand_addr(st.addr);delay(150);                     // address must be in the controller before advertising
    uint8_t t=GAP_LOCAL_ADDR_LE_RANDOM;le_adv_set_param(GAP_PARAM_ADV_LOCAL_ADDR_TYPE,sizeof(t),&t);le_adv_start();delay(200);
    T_GAP_DEV_STATE ds;le_get_gap_param(GAP_PARAM_DEV_STATE,&ds);uint8_t gt=0xFF;le_adv_get_param(GAP_PARAM_ADV_LOCAL_ADDR_TYPE,&gt);
    ok=cause==GAP_SUCCESS&&gt==GAP_LOCAL_ADDR_LE_RANDOM&&ds.gap_adv_state==GAP_ADV_STATE_ADVERTISING;
  }
  if(ok)snprintf(bleAddrLine,sizeof(bleAddrLine),"BLE_ADDR RAND %02X:%02X:%02X:%02X:%02X:%02X %s",st.addr[5],st.addr[4],st.addr[3],st.addr[2],st.addr[1],st.addr[0],created?"NEW":"KEPT");
  else{ // recoverable: keep BLE alive on the factory address
    le_adv_stop();delay(60);uint8_t t=GAP_LOCAL_ADDR_LE_PUBLIC;le_adv_set_param(GAP_PARAM_ADV_LOCAL_ADDR_TYPE,sizeof(t),&t);le_adv_start();
    snprintf(bleAddrLine,sizeof(bleAddrLine),"BLE_ADDR FALLBACK PUBLIC cause=%u",(unsigned)cause);}
  LOGF("%s\n",bleAddrLine);
#endif
}
void resetRgb(){rgbConfig={1,RGB_BREATHING,RGB_PINK,35,20,100,0,0,0};rgbConfig.crc=crc16((uint8_t*)&rgbConfig,sizeof(rgbConfig)-2);rgbDraft=rgbConfig;}
void loadRgb(){RgbConfig p;prefs.begin("nu87-ui",true);size_t n=prefs.getBytes("rgb",&p,sizeof(p));prefs.end();if(n==sizeof(p)&&p.version==1&&p.effect<=RGB_PASTEL_CYCLE&&p.color<=RGB_CUSTOM&&p.brightness<=100&&p.speed10>=5&&p.speed10<=50&&p.crc==crc16((uint8_t*)&p,sizeof(p)-2)){if(p.customR>=180)p.customR=100;rgbConfig=p;}else resetRgb();rgbDraft=rgbConfig;}
bool saveRgb(){rgbConfig=rgbDraft;rgbConfig.crc=crc16((uint8_t*)&rgbConfig,sizeof(rgbConfig)-2);prefs.begin("nu87-ui");size_t n=prefs.putBytes("rgb",&rgbConfig,sizeof(rgbConfig));prefs.end();cfgChanged();rgbDraft=rgbConfig;LOGF("RGB_SAVE bytes=%u ok=%u\n",(unsigned)n,n==sizeof(rgbConfig));return n==sizeof(rgbConfig);}

struct Action { uint8_t id; const char *name,*shortName,*cat; };
const Action ACTIONS[]={ {1,"Claude","Claude","AI"},{2,"Codex","Codex","AI"},{3,"AI Accept","Accept","AI"},{4,"AI Stop","Stop","AI"},{54,"Reasoning Up","Reason +","AI"},{55,"Reasoning Down","Reason -","AI"},{56,"GPT Mode Menu","GPT Menu","AI"},{10,"Copy","Copy","Shortcut"},{11,"Paste","Paste","Shortcut"},{12,"Undo","Undo","Shortcut"},{13,"Screenshot","Shot","Shortcut"},{57,"Scroll Down","Scrl Dn","Shortcut"},{58,"Scroll Up","Scrl Up","Shortcut"},{20,"Play / Pause","Play","Media"},{21,"Next Track","Next","Media"},{22,"Previous Track","Prev","Media"},{23,"Mute","Mute","Media"},{50,"Volume Up","Vol +","Media"},{51,"Volume Down","Vol -","Media"},{30,"Next Profile","Profile","Device"},{31,"Key Mapping","Keymap","Device"},{52,"Brightness Up","Bright +","Device"},{53,"Brightness Down","Bright -","Device"},{60,"Next Knob Mode","KnobMode","Device"},{40,"Usagi React","Usagi","Fun"},{41,"Lunch Pick","Lunch","Fun"},{61,"GPT Mode","GPT Mode","Device"},{63,"AI Activity","AI Act","Device"},{70,"Custom 1","Cust 1","Fun"},{71,"Custom 2","Cust 2","Fun"},{72,"Custom 3","Cust 3","Fun"},{73,"Custom 4","Cust 4","Fun"},{0,"None","-",""} };
constexpr uint8_t ACTION_COUNT=sizeof(ACTIONS)/sizeof(ACTIONS[0]); const Action& action(uint8_t id){for(uint8_t i=0;i<ACTION_COUNT;i++)if(ACTIONS[i].id==id)return ACTIONS[i];return ACTIONS[ACTION_COUNT-1];}

// ── UI/device state ────────────────────────────────────────────────────────
Screen screen=HOME; Stage stage=KM_KEY; uint8_t kmKey=0,kmInput=0,kmPick=0,kmConfirm=0; bool redrawAll=true,homeStatic=true;
uint8_t kmCat=0,kmDirtyTabs=0; struct GestureOut{uint8_t key,type;uint32_t t,p;}; GestureOut gOut[16];uint8_t gHead=0,gTail=0; // t = when due, p = physical press time
bool renderPending=true; uint8_t lcdLayers=0; uint32_t screenEpoch=0,renderEpoch=0; bool abortOnGesture=false;      // lcdLayers: bit per Screen that may have pixels on the LCD
constexpr uint8_t RGB_ROWS=7; // Effect, Color, Hue, Brightness, Speed, Save, Cancel
uint8_t rgbRow=0; uint8_t rgbDirtyMask=0; // bits0-6 rows, bit7 footer
enum LunchDirty:uint8_t{LD_CARD=1,LD_MSG=4,LD_SPRITE=8,LD_HEAD=16,LD_FOOT=32}; enum GptDirty:uint8_t{GD_NOTE=0x40,GD_FOOT=0x80}; // GPT bits 0-5 = rows
struct BubShown{int8_t layout;uint8_t id[2];uint32_t hash[2];}; BubShown bub={-1,{255,255},{0,0}}; // Home bubble on the LCD: layout -1 unknown, 0 none, 1 full, 2 two half bubbles
uint8_t aiActDirty=0xFF,aiPage=0,aiActView=0;uint8_t lunchDirty=0xFF,lunchBtnDirty=31,gptDirty=0xFF;int8_t lunchShownSprite=-1;bool gptEdit=false;
uint8_t homeDirty=0xFF; enum HomeDirty:uint8_t{HD_CLOCK=1,HD_WX=2,HD_MOCK=4,HD_STATUS=8,HD_BUBBLE=16,HD_DATE=32};
void invalidateRgbRow(uint8_t row){if(row<RGB_ROWS)rgbDirtyMask|=(uint8_t)(1U<<row);} void invalidateRgbFooter(){rgbDirtyMask|=0x80;}
enum KeymapDirty:uint8_t{KM_DIRTY_NONE=0,KM_DIRTY_PANEL=1,KM_DIRTY_HINT=2,KM_DIRTY_HEADER=4,KM_DIRTY_DETAIL=8,KM_DIRTY_LIST=16};
uint16_t kmDirtyTiles=0,kmDirtyTileSelection=0;uint8_t kmDirtyRows=0,kmDirtyFlags=KM_DIRTY_NONE;
uint8_t kmDetailOldKey=0;uint32_t keymapEventUs=0,keymapLayoutUs=0;
void invalidateKmTile(uint8_t k){kmDirtyTiles|=1U<<k;} void invalidateKmTileSelection(uint8_t k){kmDirtyTileSelection|=1U<<k;} void invalidateKmPanel(){kmDirtyFlags|=KM_DIRTY_PANEL;} void invalidateKmHint(){kmDirtyFlags|=KM_DIRTY_HINT;}
char toast[55]=""; uint16_t toastColor=UI_GRAY; uint32_t toastUntil=0; bool sourceMock=false;
// No mock values: time and weather stay "--" until the Mac Companion has delivered real data (CK| clock sync, WS|/WN| weather).
struct Status { uint8_t hour=0,minute=0,weekday=0,day=1,month=0; bool hasTime=false,hasWeather=false; int8_t temp=0; char city[28]=""; uint8_t weather=0,aiClaude=1,aiCodex=0; uint32_t minuteAt=0; } status;
bool clk12=false; char wxNameS[28]={0}; uint8_t wxState=0; uint32_t wxAt=0; // wxState: 0 stale / no data, 1 fresh, 2 no weather location set
void say(const char *s,uint16_t c,uint32_t now){strncpy(toast,s,sizeof(toast)-1);toast[sizeof(toast)-1]=0;toastColor=c==UI_PINK?UI_PINK_TX:c==UI_SKY?UI_SKY_TX:c;toastUntil=now+TOAST_MS;if(screen==KEYMAP)invalidateKmHint();else if(screen==RGB_SETTINGS)invalidateRgbFooter();else if(screen==LUNCH)lunchDirty|=LD_FOOT;else if(screen==GPT_MODE)gptDirty|=GD_FOOT;else if(screen==AI_ACT)aiActDirty|=8;else homeDirty|=HD_STATUS;}
bool toastHandleLine(char*s){if(s[0]!='T'||s[1]!='S'||s[2]!='|')return false;char b[48];strncpy(b,s+3,23);b[23]=0;for(char*p=b;*p;p++)if(*p=='\n'||*p=='\r')*p=0;if(!strncmp(b,"Effort",6)&&strlen(b)<20)strcat(b," · new sessions");if(b[0])say(b,UI_SKY,millis());return true;} // short status line from the Mac (e.g. knob reasoning change)
void clearToastIfDue(uint32_t now){if(toast[0]&&now>=toastUntil){toast[0]=0;if(screen==KEYMAP)invalidateKmHint();else if(screen==RGB_SETTINGS)invalidateRgbFooter();else if(screen==LUNCH)lunchDirty|=LD_FOOT;else if(screen==GPT_MODE)gptDirty|=GD_FOOT;else if(screen==AI_ACT)aiActDirty|=8;else homeDirty|=HD_STATUS;}}
void paint(); void paintRgbSwatch(bool force);
const char *screenName(Screen s){return s==HOME?"HOME":s==KEYMAP?"KEYMAP":s==RGB_SETTINGS?"RGB_SETTINGS":s==LUNCH?"LUNCH":s==GPT_MODE?"GPT_MODE":"AI_ACT";}
void gestureReset();
uint8_t knobRunCount=0; // pending merged rotation steps (see knobTurn)
// A screen change only records the request. loop() renders it, and a newer request
// (PA7) cancels the render in flight instead of queueing behind it.
void setScreen(Screen s){if(screen==s)return;LOGF("SCREEN_REQUEST %s LAT_US %lu\n",screenName(s),pa7AcceptedUs?(unsigned long)(micros()-pa7AcceptedUs):0UL);pa7AcceptedUs=0;gestureReset();if(knobModeEdit){knob.mode=knobModeOld;knobModeEdit=false;}knobRunCount=0;screenEpoch++;screen=s;aiActDirty=0xFF;lunchDirty=0xFF;lunchBtnDirty=31;gptDirty=0xFF;gptEdit=false;redrawAll=true;homeStatic=true;rgbDirtyMask=0xFF;homeDirty=0xFF;renderPending=true;}
void openKeymap(){rgbPreviewActive=false;stage=KM_KEY;setScreen(KEYMAP);} void openRgb(){rgbDraft=rgbConfig;rgbPreviewActive=true;rgbEditing=false;rgbRow=0;setScreen(RGB_SETTINGS);} void home(){rgbPreviewActive=false;setScreen(HOME);}

// ── Layout geometry: single source of truth for paint, clear and Usagi masking ──
struct Rect{int16_t x,y,w,h;};
constexpr uint8_t HOME_RECT_COUNT=6;
const Rect HOME_CLOCK={12,4,160,64},HOME_WX={326,6,142,62},HOME_MOCK={206,6,116,58},HOME_PROFILE={12,276,96,44},HOME_NEXT={360,276,108,44},HOME_STATUS={108,296,262,24};
const Rect HOME_RECTS[HOME_RECT_COUNT]={HOME_CLOCK,HOME_WX,HOME_MOCK,HOME_PROFILE,HOME_NEXT,HOME_STATUS};
// Home: one fixed sprite canvas (original Usagi illustrations) and a bubble area for notifications, between the HUD rows.
const Rect HOME_SPRITE={78,78,184,180},HOME_BUBBLE={272,80,196,112};
const Rect UI_HEADER={0,0,480,28},UI_FOOTER={0,294,480,26},KM_PANEL={246,28,228,244},RGB_SWATCH={372,38,92,116};
// Physical NU87 layout: SW1-3 bottom row (heart key = SW1), SW4/5, SW6/7, SW8/9 are the 2x3 block right of the LCD.
Rect kmTile(uint8_t k){if(k==KNOB_KEY)return {12,32,72,58};if(k<3)return {(int16_t)(12+k*78),222,72,58};uint8_t i=k-3;return {(int16_t)(90+(i&1)*78),(int16_t)(32+(i>>1)*62),72,58};}
Rect rgbRowRect(uint8_t r){return {12,(int16_t)(36+r*31),352,28};}
bool inRects(const Rect *r,uint8_t n,int x,int y,int w,int h){for(uint8_t i=0;i<n;i++)if(x>=r[i].x&&y>=r[i].y&&x+w<=r[i].x+r[i].w&&y+h<=r[i].y+r[i].h)return true;return false;}
uint8_t layerRects(Screen s,Rect *o){ // o must hold 12 entries; every rect here is fully repainted by its screen
  uint8_t n=0;
  if(s==HOME){for(uint8_t i=0;i<HOME_RECT_COUNT;i++)o[n++]=HOME_RECTS[i];o[n++]=HOME_SPRITE;o[n++]=HOME_BUBBLE;}
  else if(s==KEYMAP){o[n++]=UI_HEADER;for(uint8_t k=0;k<10;k++)o[n++]=kmTile(k);o[n++]=KM_PANEL;o[n++]=UI_FOOTER;}
  else if(s==RGB_SETTINGS){o[n++]=UI_HEADER;for(uint8_t r=0;r<RGB_ROWS;r++)o[n++]=rgbRowRect(r);o[n++]=RGB_SWATCH;o[n++]=UI_FOOTER;}
  else if(s==LUNCH){o[n++]=UI_HEADER;o[n++]=Rect{12,36,184,180};o[n++]=Rect{208,36,260,148};for(uint8_t i=0;i<3;i++)o[n++]=Rect{(int16_t)(208+i*88),192,84,40};o[n++]=Rect{208,240,260,48};o[n++]=UI_FOOTER;}
  else if(s==GPT_MODE){o[n++]=UI_HEADER;for(uint8_t r=0;r<6;r++)o[n++]=Rect{12,(int16_t)(36+r*34),456,30};o[n++]=Rect{12,246,456,44};o[n++]=UI_FOOTER;}
  else{o[n++]=UI_HEADER;o[n++]=Rect{12,36,456,112};o[n++]=Rect{12,156,456,132};o[n++]=UI_FOOTER;}
  return n;
}

// ── Usagi: original illustrations, drawn only when the expression changes (static images: no per-frame LCD traffic) ──
enum UsagiClip:uint8_t{USAGI_INTRO,USAGI_IDLE,USAGI_THINKING,USAGI_HAPPY,USAGI_SLEEPING,USAGI_ERROR,USAGI_EXCITED};
uint8_t activeClip=USAGI_IDLE;int8_t shownSprite=-1;bool notifActive=false;uint32_t reactUntil=0,doneUntil=0,lastActivityMs=0,nextFrameAt=0,lastLcdUs=0,lastBytes=0;uint16_t lastDirty=0,lastRuns=0;
void selectClip(uint8_t c){if(c>=7)return;activeClip=c;if(c==USAGI_EXCITED||c==USAGI_HAPPY)reactUntil=millis()+4000;}
// Expression priority: notification > reaction > Error > Thinking > recent Done > Sleeping after 5 min idle > Idle.
// Real AI work state per provider (Mac Companion: "AI,claude|codex,idle|thinking|done|error|approval"): 1 idle 2 working 3 done 4 error 5 approval.
// Done / Error are shown for 7 s after they arrive, then the character returns to the current state (another provider may still be working).
uint32_t aiAt[2]={0,0}; constexpr uint32_t AI_RECENT_MS=7000;
struct AiTxt{char cur[64],curBody[44],last1[64],last2[64];}; AiTxt aiTxt[2],aiStage[2]; uint8_t aiUse[2][3]={{255,255,255},{255,255,255}};uint16_t aiRst[2][2]={{0xFFFF,0xFFFF},{0xFFFF,0xFFFF}};uint8_t aiAgeMin[2]={255,255},aiSt[2]={7,7};uint32_t aiUtAt[2]={0,0}; // used % (UG) + minutes to reset / age / status (UT; status 0 ok 1 waiting 2 sign-in 3 network 4 unsupported 5 setup 6 stale 7 no data from the Mac)
// per provider visible code: 0 none, 1 working, 2 done, 3 error, 4 approval (done/error only for 7 s)
uint8_t aiCode(uint8_t p,uint32_t now){uint8_t st=p?status.aiCodex:status.aiClaude;uint8_t c=st==5?4:st==4?3:st==3?2:st==2?1:0;if((c==2||c==3)&&now-aiAt[p]>AI_RECENT_MS)c=0;return c;}
bool aiHigh(uint32_t now){return aiCode(0,now)>=2||aiCode(1,now)>=2;}
struct AiView{uint8_t code;char label[14];};
AiView aiView(uint32_t now){AiView v={0,""};uint8_t c[2]={aiCode(0,now),aiCode(1,now)};uint8_t m=c[0]>c[1]?c[0]:c[1];if(!m)return v;v.code=m;bool a=c[0]==m,b=c[1]==m;strcpy(v.label,a&&b?"Claude+Codex":a?"Claude":"Codex");return v;}
// Priority: approval > error > done > Gmail/other notifications > working.
uint8_t spriteWanted(uint32_t now){AiView a=aiView(now);if(a.code==4)return SPR_NOTIFY;if(a.code==3)return SPR_SAD;if(a.code==2)return SPR_HAPPY;if(notifActive)return SPR_NOTIFY;if((int32_t)(reactUntil-now)>0)return SPR_HAPPY;if(a.code==1)return SPR_THINKING;if(now-lastActivityMs>300000UL)return SPR_SLEEPING;return SPR_IDLE;}
bool drawHomeSprite(uint8_t id){shownSprite=-1;uint32_t t=micros(),b=tft.wireBytes();bool ok=tft.drawSprite(HOME_SPRITE.x,HOME_SPRITE.y,id);if(ok)shownSprite=id;lastLcdUs=micros()-t;lastBytes=tft.wireBytes()-b;return ok;}
void serviceSprite(uint32_t now){if(screen!=HOME||renderPending)return;uint8_t w=spriteWanted(now);if((int8_t)w==shownSprite)return;abortOnGesture=true;bool ok=drawHomeSprite(w);abortOnGesture=false;if(ok)LOGF("SPRITE %u LCD_US %lu BYTES %lu\n",w,(unsigned long)lastLcdUs,(unsigned long)lastBytes);}
// Clear every source-layer rectangle the target will not itself repaint.
uint32_t clearLayer(Screen source,Screen target){
  Rect src[16],dst[16];uint8_t ns=layerRects(source,src),nd=layerRects(target,dst);uint32_t pixels=0;
  for(uint8_t i=0;i<ns;i++){if(renderAborted())break;if(inRects(dst,nd,src[i].x,src[i].y,src[i].w,src[i].h))continue;tft.fillRect(src[i].x,src[i].y,src[i].w,src[i].h,UI_BG);pixels+=(uint32_t)src[i].w*src[i].h;}
  return pixels;
}
// Render `target` from whatever the panel currently holds. lcdLayers lists every layer that may have
// pixels on the LCD (including half-drawn ones), so a cancelled render is repaired by the next one
// without a panel reset or full-screen clear. Returns false if a newer PA7 request cancelled it.
bool renderTransition(Screen target){
  uint32_t t0=micros(),b0=tft.wireBytes();renderEpoch=screenEpoch; // pixels may only be written for the newest request
  auto cancelled=[&](){LOGF("RENDER_CANCEL %s SENT_BYTES %lu\n",screenName(target),(unsigned long)(tft.wireBytes()-b0));return false;};
  lcdLayers|=1U<<target; // tracked before anything is skipped as 'target repaints it', so a cancelled paint is still cleaned later
  for(uint8_t L=0;L<6;L++){if(L==target||!(lcdLayers&(1U<<L)))continue;clearLayer((Screen)L,target);if(renderAborted())return cancelled();if(L==HOME){shownSprite=-1;bub.layout=-1;}if(L==LUNCH)lunchShownSprite=-1;lcdLayers&=~(1U<<L);} // the whole Usagi stage was cleared as one rectangle: every cell is now blank
  paint(); // opaque full composition of the target (Home: HUD + dark stage, then the sprite cells below)
  if(renderAborted())return cancelled();
  if(target==HOME){drawHomeSprite(spriteWanted(millis()));if(renderAborted())return cancelled();}
  LOGF("DIRTY_PIXELS %lu\n",(unsigned long)((tft.wireBytes()-b0)/2));LOGF("LCD_TRANSFER_US %lu\n",(unsigned long)(micros()-t0));
  return true;
}

// ── LCD UI paint helpers: each call is a known dirty rectangle ────────────
// All text is proportional Pretendard; *R variants right-align to xr. Text is clamped to maxX.
int sm(int x,int y,const char*s,uint16_t c=UI_GRAY,uint16_t bg=UI_BG,int maxX=480){return tft.uiText(x,y,s,F_SM,c,bg,maxX);}
int md(int x,int y,const char*s,uint16_t c=UI_WHITE,uint16_t bg=UI_BG,int maxX=480){return tft.uiText(x,y,s,F_MD,c,bg,maxX);}
int lg(int x,int y,const char*s,uint16_t c=UI_WHITE,uint16_t bg=UI_BG,int maxX=480){return tft.uiText(x,y,s,F_LG,c,bg,maxX);}
int xl(int x,int y,const char*s,uint16_t c=UI_WHITE,uint16_t bg=UI_BG,int maxX=480){return tft.uiText(x,y,s,F_XL,c,bg,maxX);}
int smR(int xr,int y,const char*s,uint16_t c=UI_GRAY,uint16_t bg=UI_BG){return sm(xr-tft.textWidth(s,F_SM),y,s,c,bg);}
int mdR(int xr,int y,const char*s,uint16_t c=UI_WHITE,uint16_t bg=UI_BG){return md(xr-tft.textWidth(s,F_MD),y,s,c,bg);}
int lgR(int xr,int y,const char*s,uint16_t c=UI_WHITE,uint16_t bg=UI_BG){return lg(xr-tft.textWidth(s,F_LG),y,s,c,bg);}
void rect(int x,int y,int w,int h,uint16_t c=UI_BG){tft.fillRect(x,y,w,h,c);} void rect(const Rect&r,uint16_t c=UI_BG){tft.fillRect(r.x,r.y,r.w,r.h,c);}
void outline(int x,int y,int w,int h,uint16_t c){tft.fillRect(x,y,w,1,c);tft.fillRect(x,y+h-1,w,1,c);tft.fillRect(x,y+1,1,h-2,c);tft.fillRect(x+w-1,y+1,1,h-2,c);} // 4 thin fills (one window each) instead of per-pixel writes
void outline2(const Rect&r,uint16_t c){outline(r.x,r.y,r.w,r.h,c);outline(r.x+1,r.y+1,r.w-2,r.h-2,c);}
// Weather icon (22x22): kind 0 sun, 1 moon, 2 partly cloudy, 3 cloud, 4 fog, 5 rain, 6 snow, 7 thunder. Built from row fills (one window each), not per-pixel calls.
void disc(int cx,int cy,int r,uint16_t c){for(int dy=-r;dy<=r;dy++){int dx=0;while((dx+1)*(dx+1)+dy*dy<=r*r+r)dx++;rect(cx-dx,cy+dy,2*dx+1,1,c);}}
void cloudShape(int x,int y,uint16_t c){disc(x+7,y+13,5,c);disc(x+13,y+10,6,c);disc(x+18,y+14,4,c);rect(x+7,y+14,11,5,c);}
void weatherIcon(int x,int y,uint8_t k){
  if(k==0){disc(x+11,y+11,6,UI_PINK);rect(x+10,y,2,3,UI_PINK);rect(x+10,y+19,2,3,UI_PINK);rect(x,y+10,3,2,UI_PINK);rect(x+19,y+10,3,2,UI_PINK);}
  else if(k==1){disc(x+11,y+11,8,UI_SKY);disc(x+15,y+8,7,UI_BG);}
  else if(k==2){disc(x+8,y+8,5,UI_PINK);cloudShape(x+1,y+3,UI_SKY);}
  else if(k==4){for(int i=0;i<3;i++)rect(x+(i&1)*3,y+5+i*5,17,2,UI_DIM);}
  else{cloudShape(x,y,UI_SKY);
    if(k==5){for(int i=0;i<3;i++)rect(x+6+i*5,y+18,2,4,UI_SKY_TX);}
    else if(k==6){for(int i=0;i<3;i++)rect(x+6+i*5,y+19,3,3,UI_SKY_TX);}
    else if(k==7){rect(x+11,y+17,3,3,UI_PINK_TX);rect(x+9,y+19,3,3,UI_PINK_TX);rect(x+11,y+21,2,1,UI_PINK_TX);}}}
// ── Notification bubble (Home): queue of 4, priority first, 8 s each; only the bubble rectangle is repainted ──
// Mac->board lines (<=20 bytes): NS|id|kind|prio  NT|id|<hex title bytes>  NB|id|<hex body bytes>  NE|id|<title len hex>|<body len hex>; board answers NACK|id|OK|FULL|BAD.
// kind: t=TEST (Companion test button), g=Gmail, s=settings, c=Claude/Codex, l=lunch, m=other. Title is shown on at most 2 lines, body on 1.
struct Notif{uint8_t id,prio;char kind;char title[64],body[40];uint32_t seq;bool used;}; constexpr uint8_t NQ=4; constexpr uint32_t NOTIF_MS=8000;
Notif nq[NQ]; int8_t nShown=-1; uint32_t nShownAt=0,nSeq=0;
char nsTitle[64],nsBody[40];uint8_t nsId=0,nsPrio=0,nsTl=0,nsBl=0;char nsKind='t';bool nsOpen=false;volatile bool nsReady=false;char nsAck[20];volatile bool nsAckPend=false;
int8_t hexv(char c);
uint8_t hex2(const char*p){int h=hexv(p[0]),l=hexv(p[1]);return (h<0||l<0)?0xFF:(uint8_t)(h*16+l);}
bool notifHandleLine(char*s){size_t n=strlen(s);while(n&&(s[n-1]=='\n'||s[n-1]=='\r'))s[--n]=0;if(n<6||s[0]!='N'||s[2]!='|'||s[5]!='|')return false;if(s[1]!='S'&&s[1]!='T'&&s[1]!='B'&&s[1]!='E')return false;
  uint8_t id=hex2(s+3);if(id==0xFF)return true;
  if(s[1]=='S'){if(n<9||s[7]!='|')return true;nsId=id;nsKind=s[6];nsPrio=(s[8]>='0'&&s[8]<='3')?s[8]-'0':1;nsTl=nsBl=0;nsTitle[0]=nsBody[0]=0;nsOpen=true;return true;}
  if(!nsOpen||id!=nsId)return true;
  if(s[1]=='T'||s[1]=='B'){char*d=s[1]=='T'?nsTitle:nsBody;uint8_t&l=s[1]=='T'?nsTl:nsBl;uint8_t cap=s[1]=='T'?63:39;for(size_t i=6;i+1<n&&l<cap;i+=2){uint8_t b=hex2(s+i);if(b==0xFF)break;d[l++]=b;d[l]=0;}return true;}
  if(s[1]=='E'){nsOpen=false;if(n<10||s[8]!='|')return true;uint8_t tl=hex2(s+6),bl=hex2(s+9);bool ok=tl==nsTl&&bl==nsBl&&nsTl>0;if(ok)nsReady=true;else{snprintf(nsAck,sizeof(nsAck),"NACK|%02X|BAD\n",id);nsAckPend=true;}return true;}
  return true;}
uint16_t h4(const char*q){int v=0;for(int i=0;i<4;i++){int h=hexv(q[i]);if(h<0)return 0xFFFF;v=v*16+h;}return (uint16_t)v;}
bool aiHandleLine(char*s){size_t n=strlen(s);while(n&&(s[n-1]=='\n'||s[n-1]=='\r'))s[--n]=0;if(n<4||s[2]!='|'||!((s[0]=='A'&&(s[1]=='B'||s[1]=='F'||s[1]=='C'))||(s[0]=='U'&&(s[1]=='G'||s[1]=='T'))))return false;
  uint8_t p=(s[3]=='x')?1:0;
  if(s[0]=='U'&&s[1]=='T'){if(n>=19&&s[4]=='|'&&s[9]=='|'&&s[14]=='|'&&s[17]=='|'){aiRst[p][0]=h4(s+5);aiRst[p][1]=h4(s+10);aiAgeMin[p]=hex2(s+15);uint8_t st=s[18]-'0';aiSt[p]=st<=7?st:1;aiUtAt[p]=millis();if(!aiUtAt[p])aiUtAt[p]=1;aiActDirty|=4|(64<<p);homeDirty|=HD_MOCK;}return true;}
  if(s[0]=='U'){if(n>=13){uint8_t a=hex2(s+5),b=hex2(s+8),c=hex2(s+11);aiUse[p][0]=a<=100?a:255;aiUse[p][1]=b<=100?b:255;aiUse[p][2]=c<=100?c:255;aiActDirty|=4|(64<<p);homeDirty|=HD_MOCK;}return true;}
  if(s[1]=='B'){memset(&aiStage[p],0,sizeof(AiTxt));return true;}
  if(s[1]=='F'&&n>=7&&s[4]=='|'&&s[6]=='|'){uint8_t k=s[5]-'0';if(k>3)return true;char*d=k==0?aiStage[p].cur:k==1?aiStage[p].curBody:k==2?aiStage[p].last1:aiStage[p].last2;size_t cap=k==1?43:63,l=strlen(d);for(size_t i=7;i+1<n&&l<cap;i+=2){uint8_t b=hex2(s+i);if(b==0xFF)break;d[l++]=b;d[l]=0;}return true;}
  if(s[1]=='C'){bool changed=strcmp(aiStage[p].cur,aiTxt[p].cur)||strcmp(aiStage[p].curBody,aiTxt[p].curBody);memcpy(&aiTxt[p],&aiStage[p],sizeof(AiTxt));if(changed)homeDirty|=HD_BUBBLE;aiActDirty|=2;return true;}
  return true;}
void notifPush(char kind,uint8_t prio,const char*title,const char*body,uint8_t id=0){int8_t slot=-1,low=-1;for(uint8_t i=0;i<NQ;i++){if(!nq[i].used){slot=i;break;}if((int8_t)i!=nShown&&(low<0||nq[i].prio<nq[low].prio))low=i;}
  if(slot<0&&low>=0&&nq[low].prio<prio)slot=low;if(slot<0)return;Notif&q=nq[slot];q.used=true;q.id=id;q.prio=prio;q.kind=kind;q.seq=++nSeq;strncpy(q.title,title,63);q.title[63]=0;strncpy(q.body,body,39);q.body[39]=0;}
int fitBytes(const char*s,const UiFont&f,int maxW){int w=0;const char*p=s;while(*p){const char*q=p;int cp=ST7796SoftSPI::utf8Next(p);uint8_t a;ST7796SoftSPI::glyphOf(cp,f,a);if(w+a>maxW)return q-s;w+=a;}return p-s;}
// draw one clamped line; if the text does not fit it is cut and ends with ".."
void bubbleLine(int x,int y,const char*s,const UiFont&f,uint16_t c,bool md_,int maxW,uint16_t bg=UI_SURFACE){char b[64];int n=fitBytes(s,f,maxW);if(s[n]){int dots=tft.textWidth("..",f);n=fitBytes(s,f,maxW-dots);memcpy(b,s,n);b[n]=0;strcat(b,"..");}else{memcpy(b,s,n);b[n]=0;}if(md_)md(x,y,b,c,bg,x+maxW+2);else sm(x,y,b,c,bg,x+maxW+2);}
const char* aiWords(uint8_t c);
// ── Home speech bubble: hand-drawn style shells (usagi_bubbles.h) + text. cloud=working, burst=done, spiky=approval, shaky=error, soft=Gmail/other, star=Lunch.
// A shell is drawn only when layout/style changes; a text-only change clears and rewrites just the text rectangle; unchanged content sends nothing.
uint32_t bubFnv(const char*s,uint32_t h){while(*s){h^=(uint8_t)*s++;h*=16777619UL;}return h;}
uint32_t bubHash(const char*a,const char*b,uint8_t k){uint32_t h=bubFnv(a,2166136261UL);h=bubFnv(b,h);return h^(k*2654435761UL);}
// Title (MD, up to 2 lines) and a small line below, centred in the shell's measured text rectangle.
void bubbleText(uint8_t id,int X,int Y,const char*title,const char*body,bool half){
  uint16_t bg=pgm_read_word(&BUB_FILL[id]);int tx=X+pgm_read_byte(&BUB_TEXT[id][0])+2,ty=Y+pgm_read_byte(&BUB_TEXT[id][1]),tw=pgm_read_byte(&BUB_TEXT[id][2])-4,th=pgm_read_byte(&BUB_TEXT[id][3]);
  rect(tx-2,ty,tw+4,th,bg);
  if(half){bool two=th>=32&&body[0];int total=two?32:16,y0=ty+(th-total)/2;bubbleLine(tx,y0,title,F_SM,UI_WHITE,false,tw,bg);if(two)bubbleLine(tx,y0+17,body,F_SM,UI_GRAY,false,tw,bg);return;}
  int lines=th>=76?2:1;bool hasBody=body[0]&&th>=56;int total=lines*20+(hasBody?18:0);if(total>th)lines=1,total=20+(hasBody?18:0);int y0=ty+(th-total)/2;
  if(lines==1)bubbleLine(tx,y0,title,F_MD,UI_WHITE,true,tw,bg);
  else{int tl=fitBytes(title,F_MD,tw);char l1[64];memcpy(l1,title,tl);l1[tl]=0;md(tx,y0,l1,UI_WHITE,bg,tx+tw);if(title[tl])bubbleLine(tx,y0+20,title+tl,F_MD,UI_WHITE,true,tw,bg);}
  if(hasBody)bubbleLine(tx,y0+lines*20+2,body,F_SM,UI_GRAY,false,tw,bg);}
void paintBubble(){
  uint32_t now=millis();uint8_t c[2]={aiCode(0,now),aiCode(1,now)};bool hi=c[0]>=2||c[1]>=2,anyAi=c[0]||c[1];const int X=272,Y=80;
  uint8_t layout=0,id[2]={255,255};uint32_t hash[2]={0,0};char t0[2][64]={{0},{0}},b0[2][64]={{0},{0}};
  if(nShown>=0&&!hi){Notif&q=nq[nShown];layout=1;uint8_t style=q.kind=='l'?BUBS_STAR:BUBS_SOFT;id[0]=style*2;
    const char*lab=q.kind=='t'?"TEST":q.kind=='g'?"Gmail":q.kind=='s'?"Settings":q.kind=='c'?"AI":q.kind=='l'?"Lunch":"Notice";
    strncpy(t0[0],q.title,63);snprintf(b0[0],sizeof(b0[0]),"%s%s%s",lab,q.body[0]?" · ":"",q.body);hash[0]=bubHash(t0[0],b0[0],q.kind);}
  else if(anyAi){
    auto style=[](uint8_t code){return code==4?BUBS_SPIKY:code==3?BUBS_SHAKY:code==2?BUBS_BURST:BUBS_CLOUD;};
    if(c[0]&&c[1]){layout=2;for(uint8_t p=0;p<2;p++){id[p]=style(c[p])*2+1;AiTxt&t=aiTxt[p];snprintf(t0[p],sizeof(t0[p]),"%s · %s",p?"Codex":"Claude",aiWords(c[p]));strncpy(b0[p],t.cur[0]?t.cur:t.curBody,63);hash[p]=bubHash(t0[p],b0[p],c[p]);}}
    else{uint8_t p=c[0]?0:1;layout=1;id[0]=style(c[p])*2;AiTxt&t=aiTxt[p];const char*nm=p?"Codex":"Claude";
      strncpy(t0[0],t.cur[0]?t.cur:aiWords(c[p]),63);if(t.cur[0])snprintf(b0[0],sizeof(b0[0]),"%s · %s",nm,t.curBody[0]?t.curBody:aiWords(c[p]));else snprintf(b0[0],sizeof(b0[0]),"%s%s%s",nm,t.curBody[0]?" · ":"",t.curBody);
      hash[0]=bubHash(t0[0],b0[0],c[p]);}}
  if(layout==0){if(bub.layout!=0){bub.layout=-1;rect(HOME_BUBBLE,UI_BG);if(renderAborted())return;bub.layout=0;}return;}
  if(layout==1){
    if(bub.layout!=1||bub.id[0]!=id[0]){bub.layout=-1;if(!tft.drawBubbleAsset(X,Y,id[0])){return;}bubbleText(id[0],X,Y,t0[0],b0[0],false);if(renderAborted())return;bub.layout=1;bub.id[0]=id[0];bub.hash[0]=hash[0];}
    else if(bub.hash[0]!=hash[0]){bub.layout=-1;bubbleText(id[0],X,Y,t0[0],b0[0],false);if(renderAborted())return;bub.layout=1;bub.hash[0]=hash[0];}
    return;}
  bool fresh=bub.layout!=2;if(fresh){bub.layout=-1;}
  for(uint8_t i=0;i<2;i++){int y=Y+i*58;
    if(fresh||bub.id[i]!=id[i]){bub.layout=-1;if(!tft.drawBubbleAsset(X,y,id[i]))return;bubbleText(id[i],X,y,t0[i],b0[i],true);if(renderAborted())return;if(i==0)rect(X,Y+54,196,4,UI_BG);bub.id[i]=id[i];bub.hash[i]=hash[i];}
    else if(bub.hash[i]!=hash[i]){bub.layout=-1;bubbleText(id[i],X,y,t0[i],b0[i],true);if(renderAborted())return;bub.hash[i]=hash[i];}}
  bub.layout=2;}
void serviceAi(uint32_t now){static uint16_t last=0xFFFF;if(screen!=HOME)return;uint16_t sig=(aiCode(0,now)<<4)|aiCode(1,now);if(sig!=last){last=sig;homeDirty|=HD_BUBBLE|HD_STATUS;}}
void serviceNotif(uint32_t now){
  static uint32_t lastT=0;uint32_t dt=now-lastT;lastT=now;
  if(nsAckPend&&bleSendLine(nsAck))nsAckPend=false;
  if(nsReady){nsReady=false;uint32_t before=nSeq;notifPush(nsKind,nsPrio,nsTitle,nsBody,nsId);snprintf(nsAck,sizeof(nsAck),"NACK|%02X|%s\n",nsId,nSeq!=before?"OK":"FULL");nsAckPend=true;}
  if(screen!=HOME)return; // shown (and timed) only on Home
  int8_t was=nShown;
  if(nShown>=0&&aiHigh(now))nShownAt+=dt; // an approval / error / done card has priority: the notification waits and does not expire unseen
  if(nShown>=0&&now-nShownAt>=NOTIF_MS){nq[nShown].used=false;nShown=-1;}
  if(nShown<0){int8_t best=-1;for(uint8_t i=0;i<NQ;i++)if(nq[i].used&&(best<0||nq[i].prio>nq[best].prio||(nq[i].prio==nq[best].prio&&nq[i].seq<nq[best].seq)))best=i;if(best>=0){nShown=best;nShownAt=now;}}
  if(nShown!=was||(nShown>=0&&nShownAt==now)){notifActive=nShown>=0;homeDirty|=HD_BUBBLE;}
}
bool aiHasLimit(uint8_t p,uint8_t w);uint16_t aiProvCol(uint8_t p,uint8_t st);void pbar(int x,int y,int w,int h,int pct,uint16_t col);
void paintHomeStatic(){rect(HOME_PROFILE);sm(13,278,"PROFILE",UI_DIM);md(12,296,PROFILE[config.active],UI_WHITE,UI_BG,106);rect(HOME_NEXT);smR(468,278,PA7_SCREEN_BUTTON_SAFE?"PA7":"HOLD",UI_DIM);mdR(468,296,"Next Screen",UI_GRAY);homeStatic=false;}
const char *aiState(uint8_t v,bool){return v==5?"Approval":v==2?"Thinking":v==3?"Done":v==4?"Error":v?"Idle":"Offline";}
void paintHomeDynamic(){
  char b[32];
  if(homeDirty&HD_CLOCK){rect(12,4,160,44);if(status.hasTime){int h=status.hour;if(clk12){int hh=h%12;if(!hh)hh=12;snprintf(b,sizeof(b),"%d:%02u",hh,status.minute);}else snprintf(b,sizeof(b),"%02u:%02u",h,status.minute);int w=xl(12,4,b);if(clk12)lg(12+w+5,22,h>=12?"PM":"AM",UI_GRAY);}else xl(12,4,"--:--",UI_DIM);}
  if(homeDirty&HD_DATE){rect(14,48,172,18);if(status.hasTime){static const char*wd[]={"Sun","Mon","Tue","Wed","Thu","Fri","Sat"};static const char*mo[]={"Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"};snprintf(b,sizeof(b),"%s %u %s",wd[status.weekday%7],status.day,mo[status.month%12]);sm(14,48,b,UI_GRAY,UI_BG,172);}}
  if(homeDirty&HD_WX){rect(HOME_WX);bool ok=wxState==1;if(ok)snprintf(b,sizeof(b),"%d%c",status.temp,176);else snprintf(b,sizeof(b),"--%c",176);int w=tft.textWidth(b,F_LG);lgR(468,8,b,ok?UI_WHITE:UI_DIM);if(ok)weatherIcon(468-w-30,9,status.weather);
    char cb[40];const char*src=ok?status.city:wxState==2?"위치 설정 필요":"업데이트 필요";int n=fitBytes(src,F_SM,136);if(src[n]){int dd=tft.textWidth("..",F_SM);n=fitBytes(src,F_SM,136-dd);memcpy(cb,src,n);cb[n]=0;strcat(cb,"..");}else{memcpy(cb,src,n);cb[n]=0;}smR(468,36,cb,ok?UI_GRAY:UI_DIM);}
  if(homeDirty&HD_MOCK){rect(HOME_MOCK);for(uint8_t p=0;p<2;p++){int y=8+p*29;bool ok=aiHasLimit(p,0);int pct=ok?100-aiUse[p][1]:255;char ub[24];if(ok)snprintf(ub,sizeof(ub),"%d%%",pct);else strcpy(ub,"--");sm(206,y,p?"Codex 5h":"Claude 5h",aiSt[p]==6?UI_DIM:UI_GRAY);smR(322,y,ub,ok?UI_WHITE:UI_DIM);pbar(206,y+19,116,6,pct,aiProvCol(p,aiSt[p]));}}
  if(homeDirty&HD_BUBBLE)paintBubble();
  if(homeDirty&HD_STATUS){rect(HOME_STATUS);if(toast[0])md(116,297,toast,toastColor,UI_BG,368);else{int x=116;x+=sm(x,300,"Claude",status.aiClaude?UI_WHITE:UI_GRAY,UI_BG,368)+6;x+=sm(x,300,aiState(status.aiClaude,true),status.aiClaude==2?UI_SKY_TX:status.aiClaude>=3?UI_PINK_TX:UI_GRAY,UI_BG,368)+16;x+=sm(x,300,"Codex",status.aiCodex?UI_WHITE:UI_GRAY,UI_BG,368)+6;sm(x,300,aiState(status.aiCodex,false),status.aiCodex==2?UI_SKY_TX:status.aiCodex>=3?UI_PINK_TX:UI_GRAY,UI_BG,368);}}
  homeDirty=0;
}
// Key Mapping: left = physical switch map, right = detail panel (x 246..480, y 28..206).
constexpr int KPX=258, KPR=470;
uint8_t kmId(uint8_t k,uint8_t i){if(k==KNOB_KEY)return (i>=1&&i<=4)?knob.map[knob.mode][i-1]:0;return config.keys[config.active][k].v[i];}
uint8_t kmRows(){return kmKey==KNOB_KEY?5:3;} int kmRowY(uint8_t i){return kmKey==KNOB_KEY?62+i*40:62+i*48;}
const char* kmRowLabel(uint8_t i){if(kmKey==KNOB_KEY)return i==0?"MODE":KNOB_SLOT_NAME[i-1];return i==0?"SINGLE":i==1?"DOUBLE":"HOLD";}
void tileBorder(const Rect&t,bool sel){outline2(t,sel?UI_SKY:UI_SURFACE);if(!sel)outline(t.x,t.y,t.w,t.h,UI_LINE);}
void paintKmTile(uint8_t k){Rect t=kmTile(k);bool s=k==kmKey;rect(t,UI_SURFACE);tileBorder(t,s);
  if(k==KNOB_KEY){sm(t.x+7,t.y+4,"KNOB",s?UI_SKY_TX:UI_GRAY,UI_SURFACE);md(t.x+7,t.y+22,KNOB_MODE_TILE[knob.mode],UI_WHITE,UI_SURFACE,t.x+t.w-3);sm(t.x+7,t.y+41,"mode",UI_GRAY,UI_SURFACE);return;}
  char b[12];snprintf(b,sizeof(b),"SW%u",k+1);sm(t.x+7,t.y+4,b,s?UI_SKY_TX:UI_GRAY,UI_SURFACE);const Action&a=action(config.keys[config.active][k].v[SINGLE]);md(t.x+7,t.y+22,a.shortName,a.id?UI_WHITE:UI_DIM,UI_SURFACE,t.x+t.w-3);int q=t.x+7;if(config.keys[config.active][k].v[DOUBLE])q+=sm(q,t.y+41,"2x",UI_GRAY,UI_SURFACE)+6;if(config.keys[config.active][k].v[HOLD])sm(q,t.y+41,"hold",UI_GRAY,UI_SURFACE,t.x+t.w-3);}
void refreshKmTileSelection(uint8_t k){Rect t=kmTile(k);tileBorder(t,k==kmKey);char b[12];if(k==KNOB_KEY)snprintf(b,sizeof(b),"KNOB");else snprintf(b,sizeof(b),"SW%u",k+1);sm(t.x+7,t.y+4,b,k==kmKey?UI_SKY_TX:UI_GRAY,UI_SURFACE);}
// Category navigation: tabs are always visible and follow the highlighted function. The encoder walks one
// continuous sequence AI -> Media -> Device -> Shortcut -> Fun -> None -> AI; a click picks the function.
const char* const CATS[6]={"AI","Media","Device","Shortcut","Fun","None"}; const char* const CAT_TAB[6]={"AI","Media","Device","Shortcut","Fun","-"}; constexpr uint8_t KM_CATS=6;
uint8_t catOf(uint8_t ai){const char*c=ACTIONS[ai].cat;if(!c[0])return 5;for(uint8_t i=0;i<5;i++)if(!strcmp(c,CATS[i]))return i;return 5;}
uint8_t catFirst(uint8_t cat){for(uint8_t i=0;i<ACTION_COUNT;i++)if(catOf(i)==cat)return i;return 0;}
uint8_t catCount(uint8_t cat){uint8_t n=0;for(uint8_t i=0;i<ACTION_COUNT;i++)if(catOf(i)==cat)n++;return n;}
int tabW(uint8_t i){return tft.textWidth(CAT_TAB[i],F_SM)+6;}
Rect kmTabRect(uint8_t i){int x=248;for(uint8_t j=0;j<i;j++)x+=tabW(j);return {(int16_t)x,54,(int16_t)tabW(i),22};}
void paintKmTab(uint8_t i){Rect r=kmTabRect(i);bool sel=i==kmCat;uint16_t bg=sel?UI_SKY:UI_SURFACE,fg=sel?UI_WHITE:UI_DIM;rect(r,bg);sm(r.x+3,r.y+3,CAT_TAB[i],fg,bg);if(sel)rect(r.x,r.y+r.h-2,r.w,2,UI_PINK);}
uint8_t kmSeq[ACTION_COUNT];bool kmSeqBuilt=false;
void buildKmSeq(){uint8_t n=0;for(uint8_t c=0;c<KM_CATS;c++)for(uint8_t i=0;i<ACTION_COUNT;i++)if(catOf(i)==c)kmSeq[n++]=i;kmSeqBuilt=true;}
uint8_t kmSeqPos(uint8_t ai){for(uint8_t i=0;i<ACTION_COUNT;i++)if(kmSeq[i]==ai)return i;return 0;}
bool sameCategory(uint8_t a,uint8_t b){return strcmp(ACTIONS[a].cat,ACTIONS[b].cat)==0;}
int8_t actionRow(uint8_t index){uint8_t row=0;for(uint8_t i=0;i<ACTION_COUNT;i++)if(sameCategory(i,index)){if(i==index)return row;row++;}return -1;}
uint8_t actionAtRow(uint8_t selected,uint8_t row){uint8_t q=0;for(uint8_t i=0;i<ACTION_COUNT;i++)if(sameCategory(i,selected)){if(q++==row)return i;}return 0xFF;}
void kmBar(int y,int h,bool on,uint16_t c=UI_SKY,uint16_t off=UI_SURFACE){rect(248,y,3,h,on?c:off);}
void paintKmInputRow(uint8_t i){int y=kmRowY(i);bool knobUi=kmKey==KNOB_KEY;bool on=stage==KM_INPUT&&i==kmInput;uint16_t bg=on?UI_SELBG:UI_SURFACE;rect(248,y,224,knobUi?38:44,bg);kmBar(y+2,knobUi?36:40,on,UI_SKY,bg);sm(KPX,y+2,kmRowLabel(i),on?UI_SKY_TX:UI_DIM,bg);int vy=y+(knobUi?18:19);
  if(knobUi&&i==0){char b[28];snprintf(b,sizeof(b),knobModeEdit?"< %s >":"%s",KNOB_MODE_NAME[knob.mode]);md(KPX,vy,b,knobModeEdit?UI_SKY_TX:UI_WHITE,bg,KPR);}
  else{const Action&a=action(kmId(kmKey,i));md(KPX,vy,a.name,a.id?UI_WHITE:UI_DIM,bg,KPR);}}
void refreshKmInputSelection(uint8_t i){paintKmInputRow(i);}
void paintKmActionRow(uint8_t row){int y=84+row*26;rect(248,y,224,24,UI_SURFACE);uint8_t ai=actionAtRow(kmPick,row);if(ai==0xFF)return;bool sel=ai==kmPick;uint16_t bg=sel?UI_SELBG:UI_SURFACE;rect(248,y,224,24,bg);kmBar(y+1,22,sel,UI_SKY,bg);md(KPX,y+3,ACTIONS[ai].name,sel?UI_WHITE:UI_GRAY,bg,KPR-70);if(ACTIONS[ai].id==kmId(kmKey,kmInput))smR(KPR,y+5,"CURRENT",UI_PINK_TX,bg);}
void refreshKmActionSelection(uint8_t row){paintKmActionRow(row);}
void paintKmActionCount(){rect(400,32,72,18,UI_SURFACE);char b[12];int8_t r=actionRow(kmPick);snprintf(b,sizeof(b),"%d/%u",r+1,catCount(kmCat));smR(KPR,36,b,UI_DIM,UI_SURFACE);}
void paintKmConfirmRow(uint8_t i){int y=134+i*32;bool on=kmConfirm==i;uint16_t bg=on?UI_SELBG:UI_SURFACE;rect(248,y,224,28,bg);kmBar(y+2,24,on,i?UI_PINK:UI_SKY,bg);md(KPX,y+5,i?"Cancel":"Save",on?(i?UI_PINK_TX:UI_SKY_TX):UI_GRAY,bg);}
void refreshKmConfirmSelection(uint8_t i){paintKmConfirmRow(i);}
void paintKmPanel(){rect(KM_PANEL,UI_SURFACE);outline(KM_PANEL.x,KM_PANEL.y,KM_PANEL.w,KM_PANEL.h,UI_LINE);char h[12];if(kmKey==KNOB_KEY)snprintf(h,sizeof(h),"KNOB");else snprintf(h,sizeof(h),"SW%u",kmKey+1);int w=md(KPX,32,h,UI_SKY_TX,UI_SURFACE);
  if(stage==KM_KEY||stage==KM_INPUT){smR(KPR,36,stage==KM_KEY?"PRESS TO EDIT":kmKey==KNOB_KEY?"KNOB SETTINGS":"INPUT TYPE",UI_DIM,UI_SURFACE);for(uint8_t i=0;i<kmRows();i++)paintKmInputRow(i);}
  else if(stage==KM_ACTION){md(KPX+w+10,32,kmKey==KNOB_KEY?KNOB_SLOT_NAME[kmInput-1]:kmInput==0?"Single":kmInput==1?"Double":"Hold",UI_GRAY,UI_SURFACE);for(uint8_t i=0;i<KM_CATS;i++)paintKmTab(i);for(uint8_t i=0;i<8;i++)paintKmActionRow(i);paintKmActionCount();}
  else{sm(KPX,58,"SAVE CHANGE?",UI_DIM,UI_SURFACE);md(KPX,78,action(kmId(kmKey,kmInput)).name,UI_GRAY,UI_SURFACE,KPR);md(KPX,100,ACTIONS[kmPick].name,UI_WHITE,UI_SURFACE,KPR);paintKmConfirmRow(0);paintKmConfirmRow(1);}}
void refreshKmDetailValues(){rect(256,30,70,20,UI_SURFACE);char h[12];snprintf(h,sizeof(h),"SW%u",kmKey+1);md(KPX,32,h,UI_SKY_TX,UI_SURFACE);for(uint8_t i=0;i<3;i++){int y=62+i*48;rect(256,y+19,216,18,UI_SURFACE);const Action&a=action(config.keys[config.active][kmKey].v[i]);md(KPX,y+19,a.name,a.id?UI_WHITE:UI_DIM,UI_SURFACE,KPR);}kmDetailOldKey=kmKey;}
void paintFooter(const char*hint){rect(UI_FOOTER);if(toast[0])md(12,297,toast,toastColor,UI_BG,370);else sm(12,300,hint,UI_GRAY,UI_BG,370);smR(468,300,"PA7 Next",UI_DIM);}
void paintKmHint(){paintFooter(stage==KM_KEY?"TURN key · PRESS edit · HOLD home":stage==KM_INPUT?(knobModeEdit?"TURN mode · PRESS save · HOLD cancel":"TURN input · PRESS choose · HOLD back"):stage==KM_ACTION?"TURN function · PRESS pick · HOLD back":"TURN option · PRESS confirm · HOLD back");}
int kmSeg(int x,const char*t,bool on){int w=tft.textWidth(t,F_SM)+12;uint16_t bg=on?UI_SKY:UI_SEG;rect(x,5,w,20,bg);sm(x+6,8,t,on?UI_WHITE:UI_GRAY,bg);return w+4;}
void paintKmHeader(){rect(UI_HEADER);lg(12,3,"Key Mapping");{int x=150;x+=kmSeg(x,"KEYS",kmKey!=KNOB_KEY);kmSeg(x,"KNOB",kmKey==KNOB_KEY);}int w=tft.textWidth(PROFILE[config.active],F_MD);mdR(468,5,PROFILE[config.active],UI_GRAY);smR(468-w-8,8,"PROFILE",UI_DIM);}
void paintKeymapState(bool full){uint32_t started=micros(),bytes=tft.wireBytes(),windows=tft.windowCount();if(full){paintKmHeader();for(uint8_t k=0;k<10;k++)paintKmTile(k);paintKmPanel();paintKmHint();}else{if(kmDirtyFlags&KM_DIRTY_HEADER)paintKmHeader();for(uint8_t k=0;k<10;k++){if(kmDirtyTiles&(1U<<k))paintKmTile(k);else if(kmDirtyTileSelection&(1U<<k))refreshKmTileSelection(k);}if(kmDirtyFlags&KM_DIRTY_PANEL)paintKmPanel();else{if(kmDirtyFlags&KM_DIRTY_DETAIL)refreshKmDetailValues();if(stage==KM_ACTION){for(uint8_t i=0;i<KM_CATS;i++)if(kmDirtyTabs&(1U<<i))paintKmTab(i);if(kmDirtyFlags&KM_DIRTY_LIST){for(uint8_t i=0;i<8;i++)paintKmActionRow(i);paintKmActionCount();kmDirtyRows=0;}}if(kmDirtyRows){if(stage==KM_ACTION)paintKmActionCount();for(uint8_t i=0;i<8;i++)if(kmDirtyRows&(1U<<i)){if(stage==KM_INPUT)refreshKmInputSelection(i);else if(stage==KM_ACTION)refreshKmActionSelection(i);else if(stage==KM_CONFIRM&&i<2)refreshKmConfirmSelection(i);}}}if(kmDirtyFlags&KM_DIRTY_HINT)paintKmHint();}VLOGF("KEYMAP_UPDATE full=%u us=%lu bytes=%lu windows=%lu tiles=0x%03x sel=0x%03x rows=0x%02x flags=0x%02x\n",full,micros()-started,tft.wireBytes()-bytes,tft.windowCount()-windows,kmDirtyTiles,kmDirtyTileSelection,kmDirtyRows,kmDirtyFlags);kmDirtyTiles=0;kmDirtyTileSelection=0;kmDirtyRows=0;kmDirtyFlags=0;kmDirtyTabs=0;}

// RGB Settings: rows are Effect, Color, Hue, Brightness, Speed, Save, Cancel; the LED shows the draft live.
const char *rgbEffectName(uint8_t v){return v==RGB_OFF?"Off":v==RGB_STATIC?"Static":v==RGB_BREATHING?"Breathing":"Pastel Cycle";}
const char *rgbColorName(uint8_t v){return v==RGB_WHITE?"Soft White":v==RGB_PINK?"Pastel Pink":v==RGB_SKY?"Pastel Sky":"Custom";}
// Each row remembers what it last drew. A row whose visible state did not change sends 0 bytes, a
// value-only change repaints just the value area, and only a selection change repaints the whole row.
uint8_t rgbRowState[RGB_ROWS];uint32_t rgbRowHash[RGB_ROWS]; // state: bit7 drawn, bit0 selected, bit1 editing, bit2 dimmed
uint32_t fnv(const char*s,uint32_t h=2166136261UL){while(*s){h^=(uint8_t)*s++;h*=16777619UL;}return h;}
constexpr uint16_t UI_TRACK=rgb565(229,229,229);
void paintRgbRow(uint8_t row,bool full){
  Rect rr=rgbRowRect(row);bool sel=row==rgbRow,edit=sel&&rgbEditing&&row<=4;
  char b[40];const char *label="",*value="";bool dim=false;int frac=-1;
  if(row==0){label="Effect";value=rgbEffectName(rgbDraft.effect);}
  else if(row==1){label="Color";if(rgbDraft.effect==RGB_PASTEL_CYCLE){value="Auto (cycle)";dim=true;}else if(rgbDraft.effect==RGB_OFF){value=rgbColorName(rgbDraft.color);dim=true;}else value=rgbColorName(rgbDraft.color);}
  else if(row==2){label="Hue";if(rgbDraft.color==RGB_CUSTOM&&rgbDraft.effect!=RGB_PASTEL_CYCLE){snprintf(b,sizeof(b),"%u%c",(unsigned)rgbDraft.customR*2,176);value=b;frac=rgbDraft.customR*100/179;}else{value="Custom colour only";dim=true;}}
  else if(row==3){label="Brightness";snprintf(b,sizeof(b),"%u%%",rgbDraft.brightness);value=b;frac=rgbDraft.brightness;}
  else if(row==4){label="Speed";if(rgbDraft.effect==RGB_BREATHING||rgbDraft.effect==RGB_PASTEL_CYCLE){snprintf(b,sizeof(b),"%u.%u s",rgbDraft.speed10/10,rgbDraft.speed10%10);value=b;frac=(rgbDraft.speed10-5)*100/45;}else{value="Breathing / Cycle only";dim=true;}}
  else if(row==5){label="Save";value="Store to flash";}else{label="Cancel";value="Discard changes";}
  uint8_t st=0x80|(sel?1:0)|(edit?2:0)|(dim?4:0);uint32_t h=fnv(value);
  if(!full&&rgbRowState[row]==st&&rgbRowHash[row]==h)return;
  bool whole=full||((rgbRowState[row]^st)&0x81);uint16_t bg=UI_SURFACE;
  if(whole){rect(rr,bg);if(sel)outline2(rr,UI_SKY);else outline(rr.x,rr.y,rr.w,rr.h,UI_LINE);sm(24,rr.y+6,label,sel?UI_SKY_TX:UI_DIM,bg);}
  else rect(136,rr.y+2,rr.x+rr.w-138,rr.h-4,bg);
  uint16_t vc=dim?UI_DIM:sel?UI_WHITE:UI_GRAY;
  if(edit){int x=140;x+=md(x,rr.y+5,"< ",UI_SKY_TX,bg);x+=md(x,rr.y+5,value,UI_WHITE,bg,340);md(x+4,rr.y+5,">",UI_SKY_TX,bg);}
  else md(140,rr.y+5,value,vc,bg,358);
  if(frac>=0&&!dim){rect(236,rr.y+10,122,8,UI_TRACK);rect(236,rr.y+10,122*frac/100,8,UI_SKY);}
  rgbRowState[row]=st;rgbRowHash[row]=h;
}
uint16_t lastSwatch=0xFFFF;
// The LCD swatch shows the draft colour x brightness (static); the LED itself animates the effect, so an idle RGB screen sends nothing.
void paintRgbSwatch(bool force){
  if(screen!=RGB_SETTINGS)return;uint8_t r=255,g=255,b=255;uint16_t c=UI_LINE;
  if(rgbDraft.effect!=RGB_OFF){ // the real selected colour, faded toward the light card as brightness drops (OFF = plain light grey)
    if(rgbDraft.effect==RGB_PASTEL_CYCLE){r=255;g=190;b=215;}else rgbBaseColor(rgbDraft.color,r,g,b);
    uint16_t k=25+(uint16_t)75*rgbDraft.brightness/100;
    c=rgb565((uint8_t)(240+((int)r-240)*(int)k/100),(uint8_t)(240+((int)g-240)*(int)k/100),(uint8_t)(240+((int)b-240)*(int)k/100));
  }
  if(!force&&c==lastSwatch)return;lastSwatch=c;rect(380,66,76,76,c);
}
void paintRgbFooter(){paintFooter(rgbEditing?"TURN value · PRESS confirm · HOLD cancel":"TURN item · PRESS edit · HOLD Home");}
void paintRgbState(bool full){
  uint32_t started=micros(),bytes=tft.wireBytes(),windows=tft.windowCount();
  if(full){memset(rgbRowState,0,sizeof(rgbRowState));rect(UI_HEADER);lg(12,3,"RGB Settings");smR(468,9,"AMBIENT",UI_DIM);for(uint8_t i=0;i<RGB_ROWS;i++)paintRgbRow(i,true);rect(RGB_SWATCH);sm(374,40,"PREVIEW",UI_DIM);rect(372,58,92,92,UI_SURFACE);outline(372,58,92,92,UI_LINE);paintRgbSwatch(true);paintRgbFooter();}
  else{for(uint8_t i=0;i<RGB_ROWS;i++)if(rgbDirtyMask&(1U<<i))paintRgbRow(i,false);if(rgbDirtyMask&0x1F)paintRgbSwatch(false);if(rgbDirtyMask&0x80)paintRgbFooter();}
  VLOGF("RGB_UPDATE full=%u us=%lu bytes=%lu windows=%lu row=%u edit=%u\n",full,micros()-started,tft.wireBytes()-bytes,tft.windowCount()-windows,rgbRow,rgbEditing);rgbDirtyMask=0;
}
// ── Auxiliary screens (not in the PA7 cycle): Lunch and GPT Mode. Opened by Action IDs 41 (Lunch) and 61 (GPT Mode); PA7 returns Home. ──
// Mac<->board lines (<=20 bytes). Lunch: board "LUNCH|ROLL|CONFIRM|MAP"; Mac "LS|s" searching, "LS|e|cc" error, "LB" begin, "LF|k|hex" fields (0 name 1 category 2 address), "LR|nl|cl|al|dist" commit.
// GPT: board "GPT|REQ" and "GPT|SET|m|e"; Mac "GS|n|curModel|curEffort", "GM|i|mask", "GN|i|hex name", "GE|n", "GA|OK" / "GA|ERR|c". Nothing here is applied unless the Mac confirms it.
const Rect LUNCH_SPRITE={12,36,184,180},LUNCH_CARD={208,36,260,148},LUNCH_MSG={208,240,260,48};
Rect lunchBtn(uint8_t i){if(i>=3)return {(int16_t)(208+(i-3)*134),244,126,36};return {(int16_t)(208+i*88),192,84,40};}
uint8_t lunchRad=1,lunchCat=0; // search radius index (500m,1,2,3 km) and food filter (0 all, 1-5 single, 9 several) mirrored from the Mac
uint8_t lunchSel=0,lunchState=0,lunchErr=0,lunchReq=0,lsId=0xFF;bool lunchAcked=false;uint32_t lunchSearchAt=0,lunchAckAt=0;bool lunchConfirmed=false;
char lName[52],lCat[20],lAddr[52],lsName[52],lsCat[20],lsAddr[52];uint16_t lDist=0;uint8_t lsNl=0,lsCl=0,lsAl=0;
const char* const LUNCH_ERR[]={"","위치 권한이 없어요","직장 위치를 웹에서 설정하세요","카카오 API 키가 없어요","검색에 실패했어요","오프라인이에요","주변에 음식점이 없어요","Mac이 응답하지 않아요","Mac과 연결되지 않았어요","검색 시간이 초과됐어요"};
bool lunchHandleLine(char*s){size_t n=strlen(s);while(n&&(s[n-1]=='\n'||s[n-1]=='\r'))s[--n]=0;
  if(s[0]=='L'&&s[1]=='B'&&s[2]=='|'&&n>=5){lsNl=lsCl=lsAl=0;lsName[0]=lsCat[0]=lsAddr[0]=0;uint8_t id=hex2(s+3);lsId=(id==lunchReq||id==0)?id:0xFF;return true;} // LB|id: id 0 = unsolicited (web test search), a stale request id is dropped
  if(s[0]!='L'||(s[1]!='F'&&s[1]!='R'&&s[1]!='S'&&s[1]!='C'))return false;
  if(s[1]=='C'&&n>=6&&s[2]=='|'){uint8_t r=s[3]-'0',c=s[5]-'0';if(r<4)lunchRad=r;lunchCat=c<6||c==9?c:9;lunchBtnDirty|=24;return true;}
  if(s[1]=='S'&&s[2]=='|'){if(s[3]=='s'&&n>=7){if(hex2(s+5)==lunchReq&&lunchState==1){lunchAcked=true;lunchAckAt=millis();LOGF("LUNCH_ACK id=%u\n",lunchReq);}}else if(s[3]=='e'&&n>=10){uint8_t c=hex2(s+5);if(hex2(s+8)==lunchReq){lunchErr=c<10?c:4;lunchState=3;LOGF("LUNCH_ERROR id=%u code=%u\n",lunchReq,lunchErr);lunchDirty|=LD_CARD|LD_MSG|LD_SPRITE;lunchBtnDirty=31;}}return true;}
  if(s[1]=='F'&&n>=5&&s[2]=='|'&&s[4]=='|'){if(lsId==0xFF)return true;uint8_t k=s[3]-'0';char*d=k==0?lsName:k==1?lsCat:lsAddr;uint8_t&l=k==0?lsNl:k==1?lsCl:lsAl;uint8_t cap=k==0?51:k==1?19:51;if(k>2)return true;for(size_t i=5;i+1<n&&l<cap;i+=2){uint8_t b=hex2(s+i);if(b==0xFF)break;d[l++]=b;d[l]=0;}return true;}
  if(s[1]=='R'&&n>=19&&s[2]=='|'){uint8_t nl=hex2(s+3),cl=hex2(s+6),al=hex2(s+9);if(lsId==0xFF||hex2(s+17)!=lsId)return true; // stale result: ignored
  int h1=hexv(s[12]),h2=hexv(s[13]),h3=hexv(s[14]),h4=hexv(s[15]);if(nl==lsNl&&cl==lsCl&&al==lsAl&&nl>0&&h1>=0&&h2>=0&&h3>=0&&h4>=0){strcpy(lName,lsName);strcpy(lCat,lsCat);strcpy(lAddr,lsAddr);lDist=(h1<<12)|(h2<<8)|(h3<<4)|h4;lunchConfirmed=false;lunchState=2;LOGF("LUNCH_RESULT id=%u\n",lsId);lunchDirty|=LD_CARD|LD_MSG|LD_SPRITE;lunchBtnDirty=31;}else{lunchErr=4;lunchState=3;lunchDirty|=LD_CARD|LD_MSG|LD_SPRITE;lunchBtnDirty=31;}}
  return true;}
void lunchRoll(uint32_t now){lunchReq=lunchReq>=254?1:lunchReq+1;lsId=0xFF;lunchAcked=false;char rb[24];snprintf(rb,sizeof(rb),"LUNCH|ROLL|%02X\n",lunchReq);if(!(bleReady&&bleNotify&&BLE.connected(0))||!bleSendLine(rb)){lunchState=3;lunchErr=8;LOGF("LUNCH_ERROR id=%u reason=BLE_ERROR\n",lunchReq);}else{lunchState=1;lunchSearchAt=now;LOGF("LUNCH_REQ id=%u\n",lunchReq);}lunchConfirmed=false;lunchDirty|=LD_CARD|LD_MSG|LD_SPRITE;lunchBtnDirty=31;}
uint8_t lunchSpriteWanted(){return lunchState==1?SPR_HAPPY:lunchState==2?SPR_NOTIFY:lunchState==3?SPR_SAD:SPR_IDLE;}
void paintLunchBtn(uint8_t i){Rect r=lunchBtn(i);bool sel=i==lunchSel,ok=i==0||lunchState==2;static const char*lab[3]={"다시 뽑기","확정","지도 열기"};static const char*rn[4]={"500m","1km","2km","3km"};static const char*cn[6]={"전체","한식","중식","일식","양식","분식"};char tb[32];const char*t=lab[i<3?i:0];if(i==3){snprintf(tb,sizeof(tb),"반경 %s",rn[lunchRad&3]);t=tb;}else if(i==4){snprintf(tb,sizeof(tb),"음식 %s",lunchCat<6?cn[lunchCat]:"여러 종류");t=tb;}
  rect(r,sel?UI_SKY:UI_SURFACE);outline(r.x,r.y,r.w,r.h,sel?UI_SKY:UI_LINE);int w=tft.textWidth(t,F_MD);md(r.x+(r.w-w)/2,r.y+(i>=3?9:11),t,ok?UI_WHITE:UI_DIM,sel?UI_SKY:UI_SURFACE);}
void paintLunchCard(){Rect c=LUNCH_CARD;rect(c,UI_SURFACE);outline(c.x,c.y,c.w,c.h,UI_LINE);
  if(lunchState==2){int w=tft.textWidth(lCat,F_SM)+12;rect(c.x+12,c.y+10,w,20,UI_SKY);sm(c.x+18,c.y+12,lCat,UI_WHITE,UI_SKY,c.x+c.w-12);if(lunchConfirmed){int cw=tft.textWidth("확정됨",F_SM)+12;rect(c.x+c.w-cw-12,c.y+10,cw,20,UI_PINK);sm(c.x+c.w-cw-6,c.y+12,"확정됨",UI_WHITE,UI_PINK);}
    int n1=fitBytes(lName,F_MD,c.w-24);char l1[52];memcpy(l1,lName,n1);l1[n1]=0;md(c.x+12,c.y+40,l1,UI_WHITE,UI_SURFACE,c.x+c.w-8);if(lName[n1])bubbleLine(c.x+12,c.y+62,lName+n1,F_MD,UI_WHITE,true,c.w-24);
    char d[16];if(lDist<1000)snprintf(d,sizeof(d),"%u m",lDist);else snprintf(d,sizeof(d),"%u.%u km",lDist/1000,(lDist%1000)/100);lg(c.x+12,c.y+92,d,UI_SKY_TX,UI_SURFACE);
    if(lAddr[0])bubbleLine(c.x+12,c.y+122,lAddr,F_SM,UI_GRAY,false,c.w-24);}
  else if(lunchState==1){md(c.x+12,c.y+56,"추첨 중…",UI_WHITE,UI_SURFACE);sm(c.x+12,c.y+84,"Kakao Local · FD6",UI_DIM,UI_SURFACE);}
  else if(lunchState==3){md(c.x+12,c.y+48,LUNCH_ERR[lunchErr<9?lunchErr:4],UI_PINK_TX,UI_SURFACE,c.x+c.w-8);sm(c.x+12,c.y+84,"다시 뽑기로 재시도",UI_GRAY,UI_SURFACE);}
  else{md(c.x+12,c.y+56,"다시 뽑기를 눌러요",UI_GRAY,UI_SURFACE);}}
void paintLunchMsg(){} // the settings chips (radius / food) live in this area now
void paintLunchState(bool full){if(full)lunchDirty=0xFF,lunchBtnDirty=31;
  if(lunchDirty&LD_HEAD){rect(UI_HEADER);lg(12,3,"Lunch");smR(468,9,"주변 음식점 랜덤",UI_DIM);}
  if(lunchDirty&LD_SPRITE){uint8_t w=lunchSpriteWanted();if(full||(int8_t)w!=lunchShownSprite){lunchShownSprite=-1;if(tft.drawSprite(LUNCH_SPRITE.x,LUNCH_SPRITE.y,w))lunchShownSprite=w;}}
  if(lunchDirty&LD_CARD)paintLunchCard();
  for(uint8_t i=0;i<5;i++)if(lunchBtnDirty&(1U<<i))paintLunchBtn(i);
  if(lunchDirty&LD_MSG)paintLunchMsg();
  if(lunchDirty&LD_FOOT)paintFooter("TURN select · PRESS run · HOLD home");
  lunchDirty=0;lunchBtnDirty=0;}
void openLunch(){rgbPreviewActive=false;lunchSel=0;setScreen(LUNCH);lunchRoll(millis());}
void rotateLunch(int8_t d){uint8_t o=lunchSel;lunchSel=(lunchSel+5+d)%5;lunchBtnDirty|=(1U<<o)|(1U<<lunchSel);}
void clickLunch(uint32_t now){if(lunchSel==0){lunchRoll(now);return;}
  if(lunchSel==3){lunchRad=(lunchRad+1)&3;char b[24];snprintf(b,sizeof(b),"LUNCH|SET|R|%u\n",lunchRad);bleSendLine(b);lunchBtnDirty|=8;say("반경 변경 · 다음 추첨부터 적용",UI_SKY,now);return;}
  if(lunchSel==4){lunchCat=(lunchCat>=5)?0:lunchCat+1;char b[24];snprintf(b,sizeof(b),"LUNCH|SET|C|%u\n",lunchCat);bleSendLine(b);lunchBtnDirty|=16;say("음식 종류 변경 · 다음 추첨부터 적용",UI_SKY,now);return;}
  if(lunchState!=2){say("먼저 추첨해요",UI_GRAY,now);return;}
  if(lunchSel==1){lunchConfirmed=true;bleSendLine("LUNCH|CONFIRM\n");lunchDirty|=LD_CARD|LD_MSG;say("확정했어요!",UI_PINK,now);}
  else{bool ok=bleSendLine("LUNCH|MAP\n");say(ok?"지도 열기 요청 (Mac)":"Mac과 연결되지 않았어요",ok?UI_SKY:UI_GRAY,now);}}
void serviceLunch(uint32_t now){if(screen!=LUNCH)return;if(lunchState==1){bool noAck=!lunchAcked&&now-lunchSearchAt>8000,slow=lunchAcked&&now-lunchAckAt>30000;if(noAck||slow){lunchState=3;lunchErr=noAck?7:9;LOGF("LUNCH_ERROR id=%u reason=%s\n",lunchReq,noAck?"NO_ACK":"TIMEOUT");lunchDirty|=LD_CARD|LD_MSG|LD_SPRITE;lunchBtnDirty=31;}} // no ack = Mac/BLE problem; acked but slow = search problem
  if(lunchDirty&LD_SPRITE&&!renderPending){} }

// GPT Mode: model + reasoning effort of the Codex config (list read by the Mac from ~/.codex/models_cache.json).
constexpr uint8_t GPT_MAX=8;const char* const GPT_EFF[6]={"Low","Medium","High","Extra High","Max","Ultra"};
uint8_t gptSel=0,gptN=0,gptCur=255,gptCurEff=1,gptModel=0,gptEff=1,gptState=0,gptResult=0;bool gptLoaded=false,gptBusy=false;char gptScope='N';uint8_t gptErr=0;uint32_t gptBusyAt=0,gptReqAt=0;
char gptName[GPT_MAX][18],gptNameS[GPT_MAX][18];uint8_t gptMask[GPT_MAX],gptMaskS[GPT_MAX],gptNs=0,gptCurS=255,gptCurEffS=1;uint8_t gptOldModel=0,gptOldEff=1;
Rect gptRowRect(uint8_t r){return {12,(int16_t)(36+r*34),456,30};} const Rect GPT_NOTE={12,246,456,44};
bool gptHandleLine(char*s){size_t n=strlen(s);while(n&&(s[n-1]=='\n'||s[n-1]=='\r'))s[--n]=0;if(n<4||s[0]!='G'||s[2]!='|')return false;
  if(s[1]=='S'&&n>=9){gptNs=hex2(s+3);gptCurS=hex2(s+6);gptCurEffS=s[9]-'0';if(gptNs>GPT_MAX)gptNs=0;for(uint8_t i=0;i<GPT_MAX;i++){gptNameS[i][0]=0;gptMaskS[i]=0;}return true;}
  if(s[1]=='M'&&n>=8){uint8_t i=s[3]-'0';if(i<GPT_MAX)gptMaskS[i]=hex2(s+5);return true;}
  if(s[1]=='N'&&n>=6){uint8_t i=s[3]-'0';if(i>=GPT_MAX)return true;size_t l=strlen(gptNameS[i]);for(size_t k=5;k+1<n&&l<17;k+=2){uint8_t b=hex2(s+k);if(b==0xFF)break;gptNameS[i][l++]=b;gptNameS[i][l]=0;}return true;}
  if(s[1]=='E'&&n>=4){uint8_t c=hex2(s+3);if(c==gptNs){gptN=gptNs;memcpy(gptName,gptNameS,sizeof(gptName));memcpy(gptMask,gptMaskS,sizeof(gptMask));gptCur=gptCurS;gptCurEff=gptCurEffS;if(!gptEdit){gptModel=gptCur<gptN?gptCur:0;gptEff=gptCurEff<6?gptCurEff:1;}gptLoaded=gptN>0;gptState=gptLoaded?1:2;gptDirty=0xFF;}return true;}
  if(s[1]=='A'){gptBusy=false;bool ok=(n>=5&&s[3]=='O');gptResult=ok?1:2;gptScope=(ok&&n>=7)?s[6]:'N';gptErr=(!ok&&n>=8)?s[7]-'0':0;gptDirty|=0x02|GD_NOTE|0x10;if(gptResult==2)gptState=3;return true;}
  return true;}
const char* gptEffName(uint8_t e){return e<6?GPT_EFF[e]:"?";}
void gptFixEff(){if(gptModel>=gptN)return;uint8_t m=gptMask[gptModel];if(m&(1U<<gptEff))return;if(m&2)gptEff=1;else for(uint8_t e=0;e<6;e++)if(m&(1U<<e)){gptEff=e;break;}}
void paintGptRow(uint8_t row){Rect r=gptRowRect(row);bool selectable=row>=2,sel=selectable&&gptSel==row-2;rect(r,UI_SURFACE);if(sel)outline2(r,UI_SKY);else outline(r.x,r.y,r.w,r.h,UI_LINE);
  static const char*lab[6]={"Provider","Applied","Model","Reasoning","Save","Back"};char b[48];bool ed=sel&&gptEdit&&row<=3;
  sm(24,r.y+7,lab[row],sel?UI_SKY_TX:UI_DIM,UI_SURFACE);const char*v="";uint16_t vc=sel?UI_WHITE:UI_GRAY;
  if(row==0)v="OpenAI · Codex (ChatGPT app)";
  else if(row==1){if(!gptLoaded){v=gptState==3?"Mac reported an error":"Waiting for Mac…";vc=UI_DIM;}else{if(gptCurEff<6)snprintf(b,sizeof(b),"Open chat: %s",gptEffName(gptCurEff));else snprintf(b,sizeof(b),"Open chat: not readable");v=b;if(gptCurEff>=6)vc=UI_DIM;}}
  else if(row==2){if(gptLoaded)v=gptName[gptModel<gptN?gptModel:0];else{v="-";vc=UI_DIM;}}
  else if(row==3){v=gptLoaded?gptEffName(gptEff):"-";if(!gptLoaded)vc=UI_DIM;}
  else if(row==4){v=gptBusy?"Applying…":"Apply to open chat";if(!gptLoaded)vc=UI_DIM;}
  else v="Home";
  if(ed){int x=150;x+=md(x,r.y+6,"< ",UI_SKY_TX,UI_SURFACE);x+=md(x,r.y+6,v,UI_WHITE,UI_SURFACE,430);md(x+4,r.y+6,">",UI_SKY_TX,UI_SURFACE);}else md(150,r.y+6,v,vc,UI_SURFACE,440);
  if(row==1&&gptResult){const char*t=gptResult==1?"saved":"failed";smR(456,r.y+8,t,gptResult==1?UI_PINK_TX:UI_DIM,UI_SURFACE);}}
void paintGptNote(){rect(GPT_NOTE,UI_BG);const char*a,*b="";
  if(!gptLoaded){a=gptState==2?"Manual / Unsupported: no Codex model list found on the Mac.":"Reading the model list from the Mac Companion…";}
  else if(gptResult==1){if(gptScope=='C'){a="Applied to the open conversation (verified).";b="Used from the next message. Codex CLI default is separate.";}else{a="Saved for new sessions (config.toml).";b="The open conversation is not changed.";}}
  else if(gptResult==2){a=gptErr==3?"Unsupported: model change is not available.":gptErr==4?"Open ChatGPT in front first. Nothing changed.":gptErr==5?"Sent, but the app did not confirm. Not applied.":"Not applied. Nothing was changed.";b=gptErr==3?"Reasoning is changed with Save only if the model is unchanged.":"";}
  else{a="Save changes the reasoning of the open ChatGPT conversation.";b="ChatGPT must be the front app. Model changes are Unsupported.";}
  sm(14,GPT_NOTE.y+2,a,gptResult==1?UI_PINK_TX:gptResult==2?UI_GRAY:UI_GRAY);sm(14,GPT_NOTE.y+22,b,UI_DIM);}
void paintGptState(bool full){if(full)gptDirty=0xFF;
  if(full){rect(UI_HEADER);lg(12,3,"GPT Mode");smR(468,9,"MODEL · REASONING",UI_DIM);}
  for(uint8_t i=0;i<6;i++)if(gptDirty&(1U<<i))paintGptRow(i);
  if(gptDirty&GD_NOTE)paintGptNote();
  if(gptDirty&GD_FOOT)paintFooter(gptEdit?"TURN value · PRESS confirm · HOLD cancel":"TURN item · PRESS edit/run · HOLD home");
  gptDirty=0;}
void openGpt(){rgbPreviewActive=false;gptSel=0;gptEdit=false;gptResult=0;gptBusy=false;if(!gptLoaded)gptState=0;setScreen(GPT_MODE);gptReqAt=millis();bleSendLine("GPT|REQ\n");}
void rotateGpt(int8_t d){if(gptEdit){uint8_t row=2+gptSel;if(!gptLoaded)return;if(row==2){gptModel=(gptModel+gptN+d)%gptN;gptFixEff();gptDirty|=0x0C;}else if(row==3){uint8_t m=gptMask[gptModel];for(uint8_t k=0;k<6;k++){gptEff=(gptEff+6+d)%6;if(m&(1U<<gptEff))break;}gptDirty|=0x08;}return;}
  uint8_t o=gptSel;gptSel=(gptSel+4+d)%4;gptDirty|=(1U<<(2+o))|(1U<<(2+gptSel));}
void clickGpt(uint32_t now){uint8_t row=2+gptSel;
  if(row<=3){if(!gptLoaded){say("Waiting for the model list",UI_GRAY,now);return;}if(!gptEdit){gptEdit=true;gptOldModel=gptModel;gptOldEff=gptEff;}else gptEdit=false;gptDirty|=(1U<<row)|GD_FOOT;return;}
  if(row==4){if(!gptLoaded||gptBusy)return;char b[24];snprintf(b,sizeof(b),"GPT|SET|%u|%u\n",gptModel,gptEff);if(bleSendLine(b)){gptBusy=true;gptBusyAt=now;gptResult=0;gptDirty|=0x10|0x02|GD_NOTE;}else say("Mac is not connected",UI_GRAY,now);return;}
  home();}
void serviceGpt(uint32_t now){if(screen!=GPT_MODE)return;if(gptBusy&&now-gptBusyAt>8000){gptBusy=false;gptResult=2;gptState=3;gptDirty|=0x12|GD_NOTE;}
  if(!gptLoaded&&gptState==0&&now-gptReqAt>6000){gptState=3;gptDirty|=0x02|GD_NOTE;}}
// ── AI Activity (auxiliary screen, Action 63): per provider state / task title / last result + usage bars ──
// Mac lines: "AB|p" begin, "AF|p|k|hex" fields (k 0 headline 1 body 2 last1 3 last2), "AC|p" commit; "UG|p|ctx|h5|d7" usage percent as hex (FF = not available). p: c = Claude, x = Codex.
const Rect AA_CARD={12,36,456,112},AA_BARS={12,156,456,132};
const char* aiWords(uint8_t c){return c==4?"승인 필요!":c==3?"오류 발생":c==2?"작업 완료!":c==1?"작업 중...":"대기 중";}
// ── usage helpers: remaining % = 100 - used; reset / age are counted locally from the minutes the Mac sent with the last update ──
bool aiHasLimit(uint8_t p,uint8_t w){return aiUse[p][1+w]<=100&&(aiSt[p]==0||aiSt[p]==6);}
uint16_t aiResetLeft(uint8_t p,uint8_t w,bool&known){uint16_t r=aiRst[p][w];known=r!=0xFFFF&&aiUtAt[p];if(!known)return 0;uint32_t el=(millis()-aiUtAt[p])/60000UL;return el>=r?0:r-el;}
void fmtLeft(char*o,size_t n,uint16_t m){if(m>=2880)snprintf(o,n,"%ud %uh",m/1440,(m%1440)/60);else if(m>=60)snprintf(o,n,"%uh %um",m/60,m%60);else snprintf(o,n,"%um",m);}
void fmtAge(char*o,size_t n,uint8_t p){if(!aiUtAt[p]||aiAgeMin[p]==255){snprintf(o,n,"--");return;}uint32_t m=aiAgeMin[p]+(millis()-aiUtAt[p])/60000UL;if(m<1)snprintf(o,n,"방금");else if(m<60)snprintf(o,n,"%lum 전",(unsigned long)m);else if(m<2880)snprintf(o,n,"%luh 전",(unsigned long)(m/60));else snprintf(o,n,"%lud 전",(unsigned long)(m/1440));}
const char* aiUseMsg(uint8_t p){switch(aiSt[p]){case 1:return p?"한도 읽는 중":"다음 Claude 응답 후 표시";case 2:return "로그인 필요";case 3:return "네트워크 오류";case 4:return "지원 안 됨";case 5:return "설정 필요";case 6:return "오래된 값";default:return "Mac 데이터 없음";}}
// thin rounded bar: pct 0..100 fills from the left and shrinks as the limit is used; pct>100 = unknown (empty track)
void pbar(int x,int y,int w,int h,int pct,uint16_t col){int r=h/2;rect(x+r,y,w-2*r,h,UI_TRACK);disc(x+r,y+r,r,UI_TRACK);disc(x+w-r-1,y+r,r,UI_TRACK);
  if(pct<=100&&pct>0){int fw=w*pct/100;if(fw<h)fw=h;rect(x+r,y,fw-2*r,h,col);disc(x+r,y+r,r,col);disc(x+fw-r-1,y+r,r,col);}}
uint16_t aiProvCol(uint8_t p,uint8_t st){return st==6?UI_DIM:(p?UI_SKY:UI_PINK);}
void paintAiActBar(uint8_t row,bool subOnly=false){int y=AA_BARS.y+row*44;static const char*lab[3]={"Context 사용","5h 남음","7d 남음"};bool lim=row>0;uint8_t v=aiUse[aiPage][row];bool ok=lim?aiHasLimit(aiPage,row-1):v<=100;
  char b[24];
  if(!subOnly){rect(AA_BARS.x,y,AA_BARS.w,42,UI_BG);sm(20,y+3,lab[row],UI_DIM);}else rect(20,y+21,116,18,UI_BG);
  if(row==0)sm(20,y+21,aiPage?"해당 없음":"현재 대화",UI_DIM);
  else{bool k=false;uint16_t m=aiResetLeft(aiPage,row-1,k);if(ok&&k){char t[16];fmtLeft(t,sizeof(t),m);snprintf(b,sizeof(b),"초기화 %s",t);sm(20,y+21,b,UI_DIM);}else sm(20,y+21,ok?"초기화 --":aiUseMsg(aiPage),UI_DIM,UI_BG,136);}
  if(subOnly)return;
  int pct=ok?(lim?100-v:v):255;pbar(140,y+9,250,10,pct,aiProvCol(aiPage,aiSt[aiPage]));
  if(ok)snprintf(b,sizeof(b),"%d%%",pct);else strcpy(b,"--");md(400,y+6,b,ok?UI_WHITE:UI_DIM,UI_BG);}
// AI Usage page: both providers at once (5h / 7d remaining, time to reset, last update)
const int AU_Y[2]={36,162};constexpr int AU_H=122;
void paintAiUseTimes(uint8_t p){int y=AU_Y[p];char b[24],t[16];bool k;
  for(uint8_t w=0;w<2;w++){int ry=y+30+w*32;rect(372,ry-2,92,22,UI_SURFACE);uint16_t m=aiResetLeft(p,w,k);if(aiHasLimit(p,w)&&k){fmtLeft(t,sizeof(t),m);snprintf(b,sizeof(b),"%s 후",t);smR(462,ry+2,b,UI_GRAY,UI_SURFACE);}else smR(462,ry+2,"--",UI_DIM,UI_SURFACE);}
  rect(20,y+96,440,20,UI_SURFACE);if(aiSt[p]==0){fmtAge(t,sizeof(t),p);snprintf(b,sizeof(b),"업데이트 %s",t);sm(20,y+98,b,UI_DIM,UI_SURFACE);}else if(aiSt[p]==6){fmtAge(t,sizeof(t),p);snprintf(b,sizeof(b),"오래된 값 · %s",t);sm(20,y+98,b,UI_DIM,UI_SURFACE,460);}else sm(20,y+98,aiUseMsg(p),UI_PINK_TX,UI_SURFACE,460);}
void paintAiUseBlock(uint8_t p){int y=AU_Y[p];uint16_t col=aiProvCol(p,aiSt[p]);rect(12,y,456,AU_H,UI_SURFACE);outline(12,y,456,AU_H,UI_LINE);
  const char*nm=p?"Codex":"Claude";int pw=tft.textWidth(nm,F_SM)+14;rect(24,y+8,pw,20,p?UI_SKY:UI_PINK);sm(31,y+10,nm,UI_WHITE,p?UI_SKY:UI_PINK);
  for(uint8_t w=0;w<2;w++){int ry=y+30+w*32;sm(24,ry+2,w?"7d":"5h",UI_GRAY,UI_SURFACE);bool ok=aiHasLimit(p,w);int pct=ok?100-aiUse[p][1+w]:255;pbar(62,ry+5,240,10,pct,col);char b[8];if(ok)snprintf(b,sizeof(b),"%d%%",pct);else strcpy(b,"--");md(314,ry-1,b,ok?UI_WHITE:UI_DIM,UI_SURFACE);}
  paintAiUseTimes(p);}
void paintAiActCard(){Rect c=AA_CARD;rect(c,UI_SURFACE);outline(c.x,c.y,c.w,c.h,UI_LINE);uint32_t now=millis();uint8_t code=aiCode(aiPage,now),st=aiPage?status.aiCodex:status.aiClaude;
  const char*w=st==5?"Approval":st==4?"Error":st==3?"Done":st==2?"Working":"Idle";int pw=tft.textWidth(w,F_SM)+14;rect(c.x+12,c.y+10,pw,20,code>=3?UI_PINK:UI_SKY);sm(c.x+19,c.y+12,w,UI_WHITE,code>=3?UI_PINK:UI_SKY);
  sm(c.x+pw+22,c.y+12,aiActView?"마지막 결과":"지금",UI_DIM,UI_SURFACE);
  AiTxt&t=aiTxt[aiPage];const char*l1,*l2="";
  if(aiActView==0){l1=t.cur[0]?t.cur:(st>=2?aiWords(st==5?4:st==4?3:st==3?2:1):"대기 중");l2=t.curBody;}
  else{l1=t.last1[0]?t.last1:"아직 완료된 작업이 없어요";l2=t.last2;}
  int n1=fitBytes(l1,F_MD,c.w-28);char b[64];memcpy(b,l1,n1);b[n1]=0;md(c.x+14,c.y+40,b,UI_WHITE,UI_SURFACE,c.x+c.w-8);if(l1[n1])bubbleLine(c.x+14,c.y+62,l1+n1,F_MD,UI_WHITE,true,c.w-28);
  if(l2[0])bubbleLine(c.x+14,c.y+86,l2,F_SM,UI_GRAY,false,c.w-28);}
void paintAiActState(bool full){bool all=full||aiActDirty==0xFF;if(all)aiActDirty=0xFF;bool use=aiPage==2;
  if(aiActDirty&1){rect(UI_HEADER);lg(12,3,use?"AI Usage":"AI Activity");int x=300;x+=kmSeg(x,"Claude",aiPage==0);x+=kmSeg(x,"Codex",aiPage==1);kmSeg(x,"Usage",use);}
  if(use){if(all)rect(0,28,480,268,UI_BG);
    for(uint8_t p=0;p<2;p++){if(all||(aiActDirty&(64<<p)))paintAiUseBlock(p);else if(aiActDirty&(16<<p))paintAiUseTimes(p);}
    if(aiActDirty&8)paintFooter("TURN Claude / Codex / Usage · HOLD home");
    aiActDirty=0;return;}
  if(aiActDirty&2)paintAiActCard();
  if(aiActDirty&4)for(uint8_t i=0;i<3;i++)paintAiActBar(i);
  else if(aiActDirty&(16<<aiPage))for(uint8_t i=1;i<3;i++)paintAiActBar(i,true);
  if(aiActDirty&8)paintFooter("TURN provider / usage · PRESS now / last · HOLD home");
  aiActDirty=0;}
uint32_t aiUseTickAt=0;
void serviceAiUse(uint32_t now){if(screen!=AI_ACT||now-aiUseTickAt<60000UL)return;aiUseTickAt=now;if(aiPage==2)aiActDirty|=16|32;else aiActDirty|=16<<aiPage;}
void openAiAct(){rgbPreviewActive=false;aiPage=0;aiActView=0;setScreen(AI_ACT);}
void paint(){uint32_t t=micros(),fontPrep=tft.uiPrepUs();if(screen==HOME){if(redrawAll){paintHomeStatic();homeDirty=0xFF;}paintHomeDynamic();}else if(screen==KEYMAP)paintKeymapState(redrawAll);else if(screen==RGB_SETTINGS)paintRgbState(redrawAll);else if(screen==LUNCH)paintLunchState(redrawAll);else if(screen==GPT_MODE)paintGptState(redrawAll);else paintAiActState(redrawAll);redrawAll=false;uint32_t done=micros();VLOGF("UI_PAINT screen=%u us=%lu font_prep_us=%lu dirty_cells=%u lcd_us=%lu bytes=%lu\n",screen,done-t,tft.uiPrepUs()-fontPrep,lastDirty,lastLcdUs,lastBytes);if(keymapEventUs){VLOGF("KEYMAP_EVENT LAYOUT_US %lu EVENT_TO_DONE_US %lu\n",keymapLayoutUs,done-keymapEventUs);keymapEventUs=0;keymapLayoutUs=0;}}
void benchFill(uint16_t w,uint16_t h){uint32_t started=micros(),bytes=tft.wireBytes(),windows=tft.windowCount();tft.fillRect(0,0,w,h,UI_BG);uint32_t elapsed=micros()-started,wire=tft.wireBytes()-bytes;LOGF("LCD_BENCH %ux%u pixels=%lu bytes=%lu windows=%lu us=%lu bytes_per_s=%lu\n",w,h,(uint32_t)w*h,wire,tft.windowCount()-windows,elapsed,elapsed?(wire*1000000UL/elapsed):0);}
void runLcdBench(){benchFill(100,50);benchFill(200,100);benchFill(480,320);renderEpoch=screenEpoch;lcdLayers=0;shownSprite=-1;bub.layout=-1;redrawAll=true;homeDirty=0xFF;rgbDirtyMask=0xFF;renderPending=true;nextFrameAt=millis();}

// ── State machine ported from src/ui/device.ts ────────────────────────────
// ── Per-key Single / Double / Hold state machine ──────────────────────────
// Driven by debounced edges with their own timestamps; serviceGestures() also runs inside LCD
// transfers, but only produces events. loop() executes them, so drawing never decides gestures.
enum KState:uint8_t{KS_IDLE,KS_DOWN1,KS_WAIT2,KS_DOWN2,KS_CONSUMED}; constexpr uint8_t G_PRESS=3; // G_PRESS = raw press for Key Mapping selection
struct KeyFsm{uint8_t st=KS_IDLE;uint32_t t=0,p=0;} keyFsm[9]; // t = last edge, p = first physical press
void pushGesture(uint8_t k,uint8_t type,uint32_t t,uint32_t p){uint8_t n=(gHead+1)&15;if(n==gTail)return;gOut[gHead]={k,type,t,p};gHead=n;}
inline bool timeReached(uint32_t now,uint32_t at){return (int32_t)(now-at)>=0;} // overflow-safe
bool hasBinding(uint8_t k,InputType t){return config.keys[config.active][k].v[t]!=0;}
void gestureReset(){for(uint8_t k=0;k<9;k++)keyFsm[k].st=KS_IDLE;}
void fsmTimers(uint8_t k,uint32_t now){KeyFsm&f=keyFsm[k];
  if(f.st==KS_DOWN1&&hasBinding(k,HOLD)&&timeReached(now,f.t+HOLD_MS)){pushGesture(k,HOLD,f.t+HOLD_MS,f.p);f.st=KS_CONSUMED;}      // Hold: once, release is then ignored
  else if(f.st==KS_WAIT2&&timeReached(now,f.t+DOUBLE_MS)){pushGesture(k,SINGLE,f.t+DOUBLE_MS,f.p);f.st=KS_IDLE;}}                   // Double window expired: it was a Single
void fsmEdge(uint8_t k,bool down,uint32_t t){KeyFsm&f=keyFsm[k];
  if(screen!=HOME){if(down)pushGesture(k,G_PRESS,t,t);f.st=KS_IDLE;return;}
  fsmTimers(k,t);
  if(down){if(f.st==KS_WAIT2)f.st=KS_DOWN2;else{f.st=KS_DOWN1;f.p=t;}f.t=t;return;}
  switch(f.st){
    case KS_DOWN1:if(hasBinding(k,DOUBLE)){f.st=KS_WAIT2;f.t=t;}else{pushGesture(k,SINGLE,t,f.p);f.st=KS_IDLE;}break; // no Double bound: no waiting
    case KS_DOWN2:pushGesture(k,DOUBLE,t,f.p);f.st=KS_IDLE;break;
    default:f.st=KS_IDLE;}
}
void serviceGestures(uint32_t now){
  while(edgeTail!=edgeHead){KeyEdge e=edgeQ[edgeTail];edgeTail=(edgeTail+1)&31;fsmEdge(e.key,e.down,e.t);}
  if(screen==HOME)for(uint8_t k=0;k<9;k++)fsmTimers(k,now);
}
// Local actions are executed here. Anything that needs the PC (AI, shortcuts, media, ...) has no
// transport yet, so it is only reported (event + Action ID) and the toast says it was not sent.
bool isPcAction(uint8_t id){return id==1||id==2||id==3||id==4||(id>=10&&id<=13)||(id>=20&&id<=23)||(id>=50&&id<=58&&id!=56);}
uint16_t evtSeq=0;
// EVT|seq|key|gesture|action[|count]. key 1-9 = SW, key 0 = KNOB; gesture S/D/H for keys, R(CW) L(CCW) C(click) H(hold) for the knob.
bool sendEvt(uint8_t key,char g,uint8_t id,uint8_t count){char e[44];++evtSeq;if(count>1)snprintf(e,sizeof(e),"EVT|%u|%u|%c|%u|%u\n",(unsigned)evtSeq,key,g,id,count);else snprintf(e,sizeof(e),"EVT|%u|%u|%c|%u\n",(unsigned)evtSeq,key,g,id);return bleSendLine(e);}
void nextKnobMode(uint32_t now){knob.mode=(knob.mode+1)%KNOB_MODES;saveKnob();char b[54];snprintf(b,sizeof(b),"Knob · %s",KNOB_MODE_NAME[knob.mode]);say(b,UI_SKY,now);}
void fire(uint8_t k,InputType type,uint32_t now,uint32_t pressAt,uint32_t dueAt){
  static const char*tn[]={"SINGLE","DOUBLE","HOLD"};const Action&a=action(config.keys[config.active][k].v[type]);
  bool local=a.id==0||a.id==30||a.id==31||a.id==40||a.id==41||a.id==56||a.id==60||a.id==61||a.id==63;
  bool pc=isPcAction(a.id); // PC-side actions (everything else is local)
  bool sent=pc&&sendEvt(k+1,type==SINGLE?'S':type==DOUBLE?'D':'H',a.id,1);
  LOGF("SW%u %s\n",k+1,tn[type]);LOGF("INPUT_EVENT ACT %u %s P2E_MS %lu LAG_MS %lu\n",a.id,local?"LOCAL":sent?"PC_SENT":"PC_NOT_SENT",(unsigned long)(now-pressAt),(unsigned long)(now-dueAt)); // P2E: physical press -> executed; LAG: due -> executed
  char b[54];
  if(a.id==0)snprintf(b,sizeof(b),"SW%u %s · unassigned",k+1,tn[type]);
  else if(a.id==30){config.active=(config.active+1)%2;saveConfig();snprintf(b,sizeof(b),"Profile · %s",PROFILE[config.active]);redrawAll=true;}
  else if(a.id==31){openKeymap();return;}
  else if(a.id==41){openLunch();return;}
  else if(a.id==61||a.id==56){openGpt();return;}
  else if(a.id==63){openAiAct();return;}
  else if(a.id==60){nextKnobMode(now);return;}
  else if(a.id==40){selectClip(USAGI_EXCITED);snprintf(b,sizeof(b),"SW%u %s · Usagi React",k+1,tn[type]);}
  else snprintf(b,sizeof(b),"SW%u %s · %s · %s",k+1,tn[type],a.name,sent?"sent":"no Mac link");
  say(b,(local||sent)?UI_SKY:UI_GRAY,now);
}
uint8_t bleQueueFree(){return 15-((diagnosticHead-diagnosticTail)&15);}
// Knob action on the Home screen (slot 0 CW, 1 CCW, 2 CLICK, 3 HOLD). Rotation steps are merged into `count`.
uint32_t lastReasonAt=0;
void knobFire(uint8_t slot,uint8_t count,uint32_t now){
  static const char gl[4]={'R','L','C','H'};static uint32_t noLinkAt=0;uint8_t id=knob.map[knob.mode][slot];const Action&a=action(id);
  LOGF("KNOB %c %u ACT %u\n",gl[slot],count,id);
  if(id==0){if(slot>=2)say("Knob · unassigned",UI_GRAY,now);return;}
  if(id==60){for(uint8_t c=0;c<(count>KNOB_MODES?KNOB_MODES:count);c++)nextKnobMode(now);return;}
  if(id==31){openKeymap();return;}
  if(id==41){openLunch();return;}
  if(id==54||id==55)lastReasonAt=now;   // the Mac keeps the picker open for a few seconds after a turn
  // Click on the reasoning menu action: right after turning, it CONFIRMS the chosen level (closes the picker on the Mac); otherwise it opens the GPT Mode screen.
  if(id==56&&slot==2&&lastReasonAt&&now-lastReasonAt<5000){lastReasonAt=0;bool sent=sendEvt(0,'C',62,1);say(sent?"Reasoning confirmed":"Knob · no Mac link",sent?UI_SKY:UI_GRAY,now);return;}
  if(id==63){openAiAct();return;}
  if(id==61||id==56){openGpt();return;}
  if(id==30){config.active=(config.active+1)%2;saveConfig();char b[54];snprintf(b,sizeof(b),"Profile · %s",PROFILE[config.active]);redrawAll=true;say(b,UI_SKY,now);return;}
  if(id==40){selectClip(USAGI_EXCITED);return;}
  if(!isPcAction(id)){say("Knob · not available",UI_GRAY,now);return;}
  bool sent=sendEvt(0,gl[slot],id,count);
  if(slot>=2){char b[54];snprintf(b,sizeof(b),"KNOB %s · %s · %s",KNOB_SLOT_NAME[slot],a.name,sent?"sent":"no Mac link");say(b,sent?UI_SKY:UI_GRAY,now);}
  else if(!sent&&now-noLinkAt>1500){noLinkAt=now;say("Knob · no Mac link",UI_GRAY,now);} // dropped, never replayed after reconnect
}
int8_t knobRunDir=0;
void knobFlush(uint32_t now){if(!knobRunCount)return;uint8_t slot=knobRunDir>0?0:1;if(isPcAction(knob.map[knob.mode][slot])&&bleNotify&&bleQueueFree()<3)return;knobFire(slot,knobRunCount,now);knobRunCount=0;}
void knobTurn(int16_t r,uint32_t now){int8_t dir=r>0?1:-1;uint16_t c=r>0?r:-r;if(knobRunCount&&dir!=knobRunDir){knobFlush(now);knobRunCount=0;}knobRunDir=dir;uint16_t t=knobRunCount+c;knobRunCount=t>24?24:t;knobFlush(now);}
bool renderAborted(){return pendingPa7||renderEpoch!=screenEpoch||(abortOnGesture&&gHead!=gTail);} // PA7, a newer screen request, or (Usagi frames only) a waiting key event
void keyPress(uint8_t k,uint32_t now){if(screen!=KEYMAP)return;uint8_t old=kmKey;if(knobModeEdit){knob.mode=knobModeOld;knobModeEdit=false;invalidateKmTile(KNOB_KEY);}if(old==KNOB_KEY)kmDirtyFlags|=KM_DIRTY_HEADER;if(stage==KM_CONFIRM)say("Change discarded",UI_GRAY,now);kmKey=k;kmInput=0;stage=KM_INPUT;invalidateKmTileSelection(old);invalidateKmTileSelection(k);invalidateKmPanel();invalidateKmHint();}
void rotate(int8_t d){if(screen!=KEYMAP)return;if(stage==KM_KEY){uint8_t old=kmKey;kmDetailOldKey=old;kmKey=(kmKey+10+d)%10;invalidateKmTileSelection(old);invalidateKmTileSelection(kmKey);if((old==KNOB_KEY)!=(kmKey==KNOB_KEY)){invalidateKmPanel();kmDirtyFlags|=KM_DIRTY_HEADER;}else kmDirtyFlags|=KM_DIRTY_DETAIL;}else if(stage==KM_INPUT){if(knobModeEdit){knob.mode=(knob.mode+KNOB_MODES+d)%KNOB_MODES;kmDirtyRows|=0x1F;invalidateKmTile(KNOB_KEY);return;}uint8_t old=kmInput,nr=kmRows();kmInput=(kmInput+nr+d)%nr;kmDirtyRows|=(1U<<old)|(1U<<kmInput);}else if(stage==KM_ACTION){
    if(!kmSeqBuilt)buildKmSeq();uint8_t pos=kmSeqPos(kmPick),np=(pos+ACTION_COUNT+d)%ACTION_COUNT,oldPick=kmPick,oldCat=kmCat;kmPick=kmSeq[np];kmCat=catOf(kmPick);
    if(kmCat!=oldCat){kmDirtyTabs|=(1U<<oldCat)|(1U<<kmCat);kmDirtyFlags|=KM_DIRTY_LIST;}else{int8_t a=actionRow(oldPick),b=actionRow(kmPick);if(a>=0)kmDirtyRows|=1U<<a;if(b>=0)kmDirtyRows|=1U<<b;}}else{uint8_t old=kmConfirm;kmConfirm=(kmConfirm+2+d)%2;kmDirtyRows|=(1U<<old)|(1U<<kmConfirm);}}
void rotateRgb(int8_t d){
  if(screen!=RGB_SETTINGS)return;
  if(!rgbEditing){uint8_t old=rgbRow;rgbRow=(uint8_t)((rgbRow+RGB_ROWS+d)%RGB_ROWS);invalidateRgbRow(old);invalidateRgbRow(rgbRow);return;}
  if(rgbRow==0)rgbDraft.effect=(uint8_t)((rgbDraft.effect+4+d)%4);
  else if(rgbRow==1)rgbDraft.color=(uint8_t)((rgbDraft.color+4+d)%4);
  else if(rgbRow==2)rgbDraft.customR=(uint8_t)((rgbDraft.customR+180+d*3)%180);
  else if(rgbRow==3){int v=(int)rgbDraft.brightness+d*5;if(v<0)v=0;if(v>100)v=100;rgbDraft.brightness=(uint8_t)v;}
  else if(rgbRow==4){int v=(int)rgbDraft.speed10+d*5;if(v<5)v=5;if(v>50)v=50;rgbDraft.speed10=(uint8_t)v;}
  else return;
  rgbDirtyMask|=0x1F;serviceRgb();
}
void rotateMeasured(int8_t d){if(screen==AI_ACT){uint8_t o=aiPage;aiPage=(aiPage+3+(d<0?-1:1))%3;(void)o;aiActDirty=0xFF;return;}if(screen==LUNCH){rotateLunch(d);return;}if(screen==GPT_MODE){rotateGpt(d);return;}if(screen==KEYMAP){keymapEventUs=micros();rotate(d);keymapLayoutUs=micros()-keymapEventUs;}else if(screen==RGB_SETTINGS)rotateRgb(d);else rotate(d);}
void click(uint32_t now){if(screen!=KEYMAP)return;if(stage==KM_KEY){stage=KM_INPUT;kmInput=0;}else if(stage==KM_INPUT){if(kmKey==KNOB_KEY&&kmInput==0){if(!knobModeEdit){knobModeEdit=true;knobModeOld=knob.mode;}else{knobModeEdit=false;saveKnob();char b[54];snprintf(b,sizeof(b),"Knob mode · %s",KNOB_MODE_NAME[knob.mode]);say(b,UI_PINK,now);}kmDirtyRows|=1;invalidateKmTile(KNOB_KEY);invalidateKmHint();return;}stage=KM_ACTION;uint8_t v=kmId(kmKey,kmInput);for(uint8_t i=0;i<ACTION_COUNT;i++)if(ACTIONS[i].id==v)kmPick=i;kmCat=catOf(kmPick);}else if(stage==KM_ACTION){if(ACTIONS[kmPick].id==kmId(kmKey,kmInput)){stage=KM_INPUT;say("No change",UI_GRAY,now);}else{stage=KM_CONFIRM;kmConfirm=0;}}else{if(kmConfirm==0){char b[54];if(kmKey==KNOB_KEY){knob.map[knob.mode][kmInput-1]=ACTIONS[kmPick].id;saveKnob();snprintf(b,sizeof(b),"Saved KNOB %s %s",KNOB_SLOT_NAME[kmInput-1],ACTIONS[kmPick].name);}else{config.keys[config.active][kmKey].v[kmInput]=ACTIONS[kmPick].id;saveConfig();snprintf(b,sizeof(b),"Saved SW%u %s",kmKey+1,ACTIONS[kmPick].name);}say(b,UI_PINK,now);invalidateKmTile(kmKey);}else say("Cancelled",UI_GRAY,now);stage=KM_INPUT;}invalidateKmPanel();invalidateKmHint();}
void clickRgb(uint32_t now){
  if(screen!=RGB_SETTINGS)return;
  if(rgbRow==2&&rgbDraft.color!=RGB_CUSTOM){say("Set Color to Custom first",UI_GRAY,now);return;}
  if(rgbRow<=4){rgbEditing=!rgbEditing;invalidateRgbRow(rgbRow);invalidateRgbFooter();if(!rgbEditing)serviceRgb();}
  else if(rgbRow==5){if(saveRgb()){rgbEditing=false;say("RGB settings saved",UI_PINK,now);}rgbDirtyMask|=0xFF;}
  else {rgbDraft=rgbConfig;rgbEditing=false;say("RGB changes cancelled",UI_GRAY,now);rgbDirtyMask|=0xFF;serviceRgb();}
}
void clickMeasured(uint32_t now){if(screen==AI_ACT){if(aiPage==2){aiPage=0;aiActDirty=0xFF;return;}aiActView^=1;aiActDirty|=2;return;}if(screen==LUNCH){clickLunch(now);return;}if(screen==GPT_MODE){clickGpt(now);return;}if(screen==KEYMAP){keymapEventUs=micros();click(now);keymapLayoutUs=micros()-keymapEventUs;}else if(screen==RGB_SETTINGS)clickRgb(now);else knobFire(2,1,now);}
void longPress(uint32_t now){if(screen==LUNCH||screen==AI_ACT){home();return;}if(screen==GPT_MODE){if(gptEdit){gptModel=gptOldModel;gptEff=gptOldEff;gptEdit=false;gptDirty|=0x0C|GD_FOOT;}else home();return;}if(screen==HOME){knobFire(3,1,now);return;}if(screen==RGB_SETTINGS){if(rgbEditing){rgbDraft=rgbConfig;rgbEditing=false;serviceRgb();say("RGB edit cancelled",UI_GRAY,now);rgbDirtyMask|=0xFF;}else home();return;}if(stage==KM_KEY){home();return;}if(stage==KM_INPUT){if(knobModeEdit){knob.mode=knobModeOld;knobModeEdit=false;kmDirtyRows|=0x1F;invalidateKmTile(KNOB_KEY);invalidateKmHint();return;}stage=KM_KEY;}else if(stage==KM_ACTION){stage=KM_INPUT;say("Cancelled",UI_GRAY,now);}else{stage=KM_ACTION;}invalidateKmPanel();invalidateKmHint();}

// ── Web settings sync (Mac Companion bridge) ───────────────────────────────
// 90-byte blob = 15 chunks x 6 bytes. Device->host: "CGET" then lines "C|NN|<12 hex>". Host->device: "P|NN|<12 hex>" x15 then "CCOM"
// (applied + saved in loop(), only on HOME and not while editing on the LCD); reply "CACK|OK|rev" / "CACK|ERR|code". Lines stay <=20 bytes.
// Layout: 0 ver(1) | 1 active profile | 2..55 keys[2][9][3] | 56 knob mode | 57..80 knob map[6][4] | 81 effect 82 color 83 bright 84 speed10 85 hue | 86 rev | 87 0 | 88..89 CRC16(0..87)
constexpr uint8_t CFG_LEN=90,CFG_CHUNKS=15; uint8_t cfgStage[CFG_LEN],cfgBlob[CFG_LEN]; uint16_t cfgMask=0; volatile bool cfgGetReq=false,cfgCommitReq=false; int8_t cfgTx=-1; char cfgReply[24]; bool cfgReplyPend=false; uint32_t cfgReplyAt=0;
void cfgBuild(uint8_t*b){memset(b,0,CFG_LEN);b[0]=1;b[1]=config.active;for(uint8_t p=0;p<2;p++)for(uint8_t k=0;k<9;k++)for(uint8_t i=0;i<3;i++)b[2+p*27+k*3+i]=config.keys[p][k].v[i];b[56]=knob.mode;memcpy(b+57,knob.map,24);b[81]=rgbConfig.effect;b[82]=rgbConfig.color;b[83]=rgbConfig.brightness;b[84]=rgbConfig.speed10;b[85]=rgbConfig.customR;b[86]=cfgRev;uint16_t c=crc16(b,88);b[88]=c&255;b[89]=c>>8;}
bool cfgValid(const uint8_t*b){if(b[0]!=1||b[1]>1)return false;for(uint8_t i=2;i<56;i++)if(action(b[i]).id!=b[i])return false;if(b[56]>=KNOB_MODES)return false;for(uint8_t i=57;i<81;i++)if(action(b[i]).id!=b[i])return false;return b[81]<=RGB_PASTEL_CYCLE&&b[82]<=RGB_CUSTOM&&b[83]<=100&&b[84]>=5&&b[84]<=50&&b[85]<=179;}
int8_t hexv(char c){return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1;}
bool cfgHandleLine(char*s){size_t n=strlen(s);while(n&&(s[n-1]=='\n'||s[n-1]=='\r'))s[--n]=0;
  if(!strcmp(s,"CGET")){cfgGetReq=true;return true;}
  if(!strcmp(s,"CCOM")){cfgCommitReq=true;return true;}
  if(s[0]=='P'&&s[1]=='|'&&n==17&&s[4]=='|'){int a=hexv(s[2]),b=hexv(s[3]);if(a<0||b<0)return true;uint8_t idx=a*16+b;if(idx>=CFG_CHUNKS)return true;uint8_t t[6];for(uint8_t i=0;i<6;i++){int h=hexv(s[5+i*2]),l=hexv(s[6+i*2]);if(h<0||l<0)return true;t[i]=h*16+l;}if(idx==0)cfgMask=0;memcpy(cfgStage+idx*6,t,6);cfgMask|=1U<<idx;return true;}
  return false;}
void cfgSetReply(const char*r){strncpy(cfgReply,r,sizeof(cfgReply)-1);cfgReply[sizeof(cfgReply)-1]=0;cfgReplyPend=true;cfgReplyAt=millis();}
void cfgCommit(){char r[24];
  if(cfgMask!=0x7FFF){cfgSetReply("CACK|ERR|1\n");}
  else if(crc16(cfgStage,88)!=(uint16_t)(cfgStage[88]|(cfgStage[89]<<8))){cfgSetReply("CACK|ERR|2\n");}
  else if(!cfgValid(cfgStage)){cfgSetReply("CACK|ERR|3\n");}
  else if(screen!=HOME||rgbEditing||knobModeEdit||rgbPreviewActive){cfgSetReply("CACK|ERR|4\n");}
  else{const uint8_t*b=cfgStage;cfgHostCommit=true;config.active=b[1];for(uint8_t p=0;p<2;p++)for(uint8_t k=0;k<9;k++)for(uint8_t i=0;i<3;i++)config.keys[p][k].v[i]=b[2+p*27+k*3+i];bool ok=saveConfig();knob.mode=b[56];memcpy(knob.map,b+57,24);ok&=saveKnob();
    rgbDraft=rgbConfig;rgbDraft.effect=b[81];rgbDraft.color=b[82];rgbDraft.brightness=b[83];rgbDraft.speed10=b[84];rgbDraft.customR=b[85];ok&=saveRgb();cfgHostCommit=false;
    LOGF("CFG_COMMIT ok=%u rev=%u\n",ok,(unsigned)cfgRev);if(ok){homeDirty=0xFF;say("Web: settings saved",UI_PINK,millis());notifPush('s',1,"설정이 저장됐어!","");snprintf(r,sizeof(r),"CACK|OK|%u\n",(unsigned)cfgRev);}else snprintf(r,sizeof(r),"CACK|ERR|5\n");cfgSetReply(r);}
  cfgMask=0;}
void serviceCfg(){
  if((cfgReplyPend||cfgTx>=0||cfgGetReq||cfgCommitReq)&&!(bleReady&&bleNotify&&BLE.connected(0))){cfgReplyPend=false;cfgTx=-1;cfgGetReq=false;cfgCommitReq=false;return;} // never replayed after a reconnect
  if(cfgCommitReq){cfgCommitReq=false;cfgCommit();}
  if(cfgReplyPend){if(bleSendLine(cfgReply))cfgReplyPend=false;else if(millis()-cfgReplyAt>3000)cfgReplyPend=false;return;}
  if(cfgGetReq){cfgGetReq=false;cfgBuild(cfgBlob);cfgTx=0;}
  if(cfgTx>=0){char b[24];uint8_t i=cfgTx;int o=snprintf(b,sizeof(b),"C|%02X|",i);for(uint8_t k=0;k<6;k++)o+=snprintf(b+o,sizeof(b)-o,"%02X",cfgBlob[i*6+k]);b[o++]='\n';b[o]=0;if(bleSendLine(b)){if(++cfgTx>=CFG_CHUNKS)cfgTx=-1;}}}

// ── Serial companion ingress / mock clock ─────────────────────────────────
char serialLine[80];uint8_t serialN=0;
uint8_t parseAi(const char*s){if(!strcmp(s,"approval"))return 5;if(!strcmp(s,"idle"))return 1;if(!strcmp(s,"thinking"))return 2;if(!strcmp(s,"done"))return 3;if(!strcmp(s,"error"))return 4;return 0;}
void parseCompanion(char *p){char *t=strtok(p,",");if(!t)return;if(!strcmp(t,"ACK")){strtok(nullptr,",");char*r=strtok(nullptr,",");bool ok=r&&!strcmp(r,"OK");say(ok?"Mac: done":r&&!strcmp(r,"UNSUP")?"Mac: unsupported":"Mac: failed",ok?UI_PINK:UI_GRAY,millis());return;} // ACK,<seq>,OK|FAIL|UNSUP
if(!strcmp(t,"TIME")){char*a=strtok(nullptr,","),*b=strtok(nullptr,","),*c=strtok(nullptr,","),*d=strtok(nullptr,","),*e=strtok(nullptr,",");if(a&&b&&c&&d&&e){status.hour=atoi(a);status.minute=atoi(b);status.weekday=atoi(c);status.day=atoi(d);status.month=atoi(e);status.hasTime=true;status.minuteAt=millis();sourceMock=false;}}else if(!strcmp(t,"WX")){char*k=strtok(nullptr,","),*v=strtok(nullptr,","),*city=strtok(nullptr,",");if(k&&v&&city){status.weather=!strcmp(k,"clouds")?1:!strcmp(k,"rain")?2:!strcmp(k,"snow")?3:0;status.temp=atoi(v);strncpy(status.city,city,18);status.city[18]=0;status.hasWeather=true;sourceMock=false;}}else if(!strcmp(t,"AI")){char*id=strtok(nullptr,","),*v=strtok(nullptr,",");if(id&&v){bool cl=!strcmp(id,"claude"),cx=!strcmp(id,"codex");if(cl||cx){uint8_t ns=parseAi(v);uint8_t&cur=cl?status.aiClaude:status.aiCodex;if(ns!=cur||ns>=3)aiAt[cl?0:1]=millis();cur=ns;}sourceMock=false;homeDirty|=HD_STATUS|HD_BUBBLE;return;}}homeDirty=0xFF;say("Serial data updated",UI_SKY,millis());}
void serviceSerial(){while(Serial.available()){char c=Serial.read();if(c=='\r')continue;if(c=='\n'){serialLine[serialN]=0;parseCompanion(serialLine);serialN=0;}else if(serialN<sizeof(serialLine)-1)serialLine[serialN++]=c;else serialN=0;}}
// ── Clock: Mac-synced wall time ("CK|<local seconds hex8>|<utc offset min + 0x8000, hex4>|<12h flag>"), advanced with millis() between syncs.
uint32_t clkBaseLocal=0,clkBaseMs=0,clkMinuteIdx=0xFFFFFFFFUL;bool clkSynced=false;uint8_t clkLastDay=0;
void civilFromDays(int32_t z,uint16_t&y,uint8_t&m,uint8_t&d){z+=719468;int32_t era=(z>=0?z:z-146096)/146097;uint32_t doe=z-era*146097;uint32_t yoe=(doe-doe/1460+doe/36524-doe/146096)/365;int32_t yy=yoe+era*400;uint32_t doy=doe-(365*yoe+yoe/4-yoe/100);uint32_t mp=(5*doy+2)/153;d=doy-(153*mp+2)/5+1;m=mp<10?mp+3:mp-9;y=yy+(m<=2);}
uint32_t clkLocalNow(uint32_t now){return clkBaseLocal+(now-clkBaseMs)/1000;}
uint32_t hexN(const char*p,uint8_t n){uint32_t v=0;for(uint8_t i=0;i<n;i++){int h=hexv(p[i]);if(h<0)return 0xFFFFFFFFUL;v=(v<<4)|h;}return v;}
bool clockWxHandleLine(char*s){size_t n=strlen(s);while(n&&(s[n-1]=='\n'||s[n-1]=='\r'))s[--n]=0;
  if(s[0]=='C'&&s[1]=='K'&&s[2]=='|'){if(n<18||s[11]!='|'||s[16]!='|')return true;uint32_t local=hexN(s+3,8),tzr=hexN(s+12,4);if(local==0xFFFFFFFFUL||tzr==0xFFFFFFFFUL)return true;int tz=(int)tzr-0x8000;
    if(local<1600000000UL||local>4200000000UL||tz<-720||tz>840){LOGF("CK_REJECT local=%lu tz=%d\n",(unsigned long)local,tz);return true;}
    uint32_t now=millis();if(clkSynced){long drift=(long)(local-clkLocalNow(now));LOGF("CK_SYNC drift_s=%ld tz_min=%d\n",drift,tz);}else LOGF("CK_SYNC first tz_min=%d\n",tz);
    clkBaseLocal=local;clkBaseMs=now;clkSynced=true;clk12=s[17]=='1';status.hasTime=true;clkMinuteIdx=0xFFFFFFFFUL;homeDirty|=HD_CLOCK|HD_DATE;return true;}
  if(s[0]=='W'&&s[1]=='N'&&s[2]=='|'&&n>=4&&s[4]=='|'){uint8_t i=s[3]-'0';if(i>4)return true;if(i==0)memset(wxNameS,0,sizeof(wxNameS));for(size_t k=5;k+1<n;k+=2){uint32_t b=hexN(s+k,2);if(b==0xFFFFFFFFUL)break;size_t o=i*6+(k-5)/2;if(o<27)wxNameS[o]=b;}return true;}
  if(s[0]=='W'&&s[1]=='S'&&s[2]=='|'&&n>=9&&s[4]=='|'&&s[7]=='|'){uint8_t k=s[3]-'0',f=s[8]-'0';uint32_t t=hexN(s+5,2);if(k>7||f>2||t==0xFFFFFFFFUL)return true;status.weather=k;status.temp=(int)t-64;wxState=f;wxAt=millis();status.hasWeather=f==1;memcpy(status.city,wxNameS,27);status.city[27]=0;homeDirty|=HD_WX;return true;}
  return false;}
void tickClock(uint32_t now){
  if(wxState==1&&now-wxAt>6000000UL){wxState=0;status.hasWeather=false;homeDirty|=HD_WX;} // no weather update for 100 min: never show it as current
  if(!clkSynced)return;uint32_t local=clkLocalNow(now),mi=local/60;if(mi==clkMinuteIdx)return;clkMinuteIdx=mi;
  uint32_t days=local/86400UL,sod=local%86400UL;status.hour=sod/3600;status.minute=(sod%3600)/60;status.weekday=(days+4)%7;uint16_t y;uint8_t m,d;civilFromDays((int32_t)days,y,m,d);
  if(d!=clkLastDay||status.month!=m-1){status.day=d;status.month=m-1;clkLastDay=d;homeDirty|=HD_DATE;}homeDirty|=HD_CLOCK;}

void setup(){pinMode(PIN_LED_R,OUTPUT);pinMode(PIN_LED_G,OUTPUT);pinMode(PIN_LED_B,OUTPUT);digitalWrite(PIN_LED_R,LOW);digitalWrite(PIN_LED_G,LOW);digitalWrite(PIN_LED_B,LOW);releaseRows();for(uint8_t c=0;c<3;c++)pinMode(KEY_COLS[c],INPUT_PULLUP);pinMode(PIN_ENC_CLK,INPUT_PULLUP);pinMode(PIN_ENC_DT,INPUT_PULLUP);pinMode(PIN_ENC_SW,INPUT_PULLUP);encoderState=(digitalRead(PIN_ENC_CLK)<<1)|digitalRead(PIN_ENC_DT);attachInterrupt(PIN_ENC_CLK,encoderISR,CHANGE);attachInterrupt(PIN_ENC_DT,encoderISR,CHANGE);uint32_t n=millis();candidateAt=encChangedAt=encDownAt=n;rawEnc=stableEnc=digitalRead(PIN_ENC_SW);
#if PA7_SCREEN_BUTTON_SAFE
  pinMode(PIN_PA7_BUTTON,INPUT_PULLUP);rawPa7=stablePa7=digitalRead(PIN_PA7_BUTTON);pa7ChangedAt=n;
#endif
  status.minuteAt=n;loadConfig();loadRgb();loadKnob();lastActivityMs=millis();inputReady=true;tft.begin();tft.fillScreen(UI_BG);
#if NU87_ENABLE_BLE
  beginBle();
#endif
  lcdLayers=0;renderPending=true;nextFrameAt=millis();LOGF("BOOT PA7=GPIO BLE=%u ANIM=%u MEM_ANIM_RAM=%u UI_FONT_FLASH=%u CONFIG=%u ANIM_DATA=%u\n",NU87_ENABLE_BLE,NU87_ENABLE_ANIMATION,0U,(unsigned)(sizeof(UI_SM_4BPP)+sizeof(UI_MD_4BPP)+sizeof(UI_LG_4BPP)+sizeof(UI_XL_4BPP)),(unsigned)sizeof(config),(unsigned)sizeof(SPRITE_DATA));}
void loop(){uint32_t n=millis();flushDiagnostic();serviceCfg();serviceNotif(n);serviceAi(n);serviceLunch(n);serviceGpt(n);serviceAiUse(n);
#if NU87_DIAG_HEARTBEAT_LED
  static uint32_t heartbeatAt=0;if(n-heartbeatAt>=250){heartbeatAt=n;digitalWrite(PIN_LED_G,!digitalRead(PIN_LED_G));}
#endif
#if PA7_SCREEN_BUTTON_SAFE
  servicePa7(n);
  // PA7 outranks every LCD job. A render in flight sees pendingPa7 at its next 512-byte chunk and stops
  // sending; this newest request then replaces the old target (never queued behind it).
  if(pendingPa7){pendingPa7=false;
#if NU87_DIAG_PA7_LED
    digitalWrite(PIN_LED_R,!digitalRead(PIN_LED_R));
#endif
    if(screen==HOME)openKeymap();else if(screen==KEYMAP)openRgb();else home();return;}
#endif
  if(pendingLcdBench){pendingLcdBench=false;runLcdBench();return;}
  serviceMatrix(n);serviceEncoder(n);serviceGestures(n);
  while(gTail!=gHead){GestureOut g=gOut[gTail];gTail=(gTail+1)&15;if(g.type==G_PRESS){if(screen==KEYMAP)keyPress(g.key,n);}else if(screen==HOME)fire(g.key,(InputType)g.type,millis(),g.p,g.t);}
  if(pendingDetents||pendingClick||pendingLong||gTail!=gHead)lastActivityMs=n;
  int16_t r=pendingDetents;pendingDetents=0;if(screen==HOME){if(r)knobTurn(r,n);knobFlush(n);}else{while(r>0){rotateMeasured(1);r--;}while(r<0){rotateMeasured(-1);r++;}}if(pendingClick){pendingClick=false;clickMeasured(n);}if(pendingLong){pendingLong=false;longPress(n);}
  serviceRgb();clearToastIfDue(n);tickClock(n);
  if(renderPending){renderPending=false;renderTransition(screen);return;} // cancelled renders are superseded by the pending PA7 request
#if NU87_ENABLE_ANIMATION
  serviceSprite(n);
#endif
  if(redrawAll||(screen==KEYMAP&&(kmDirtyTiles||kmDirtyTileSelection||kmDirtyRows||kmDirtyFlags||kmDirtyTabs))||(screen==RGB_SETTINGS&&rgbDirtyMask)||(screen==LUNCH&&(lunchDirty||lunchBtnDirty))||(screen==GPT_MODE&&gptDirty)||(screen==AI_ACT&&aiActDirty)||(screen==HOME&&homeDirty))paint();
  static uint32_t logAt=0;if(n-logAt>=1000){logAt=n;VLOGF("PERF screen=%u dirty_cells=%u runs=%u lcd_us=%lu bytes=%lu\n",screen,lastDirty,lastRuns,lastLcdUs,lastBytes);}}
