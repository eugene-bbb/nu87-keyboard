export type RGB = [number, number, number];

export const PAL = {
  BACKGROUND: '#080A0D',
  BODY: '#FFF4DC',
  BODY_SHADOW: '#ADA8A0',
  OUTLINE: '#303037',
  EARS_PINK: '#F3AFC5',
  CHEEK_PINK: '#F5A8BD',
  WHITE: '#F5F5F5',
  SKY_BLUE: '#A8D8F0',
  SPARKLE: '#FFFFFF',
} as const;

export const hex = (s: string): RGB => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

export const C = {
  BG: hex(PAL.BACKGROUND),
  BODY: hex(PAL.BODY),
  SHADOW: hex(PAL.BODY_SHADOW),
  OUTLINE: hex(PAL.OUTLINE),
  EAR: hex(PAL.EARS_PINK),
  CHEEK: hex(PAL.CHEEK_PINK),
  WHITE: hex(PAL.WHITE),
  SKY: hex(PAL.SKY_BLUE),
  SPARK: hex(PAL.SPARKLE),
};

/** RGB565 helpers — the LCD (ST7796S) color format */
export const to565 = (r: number, g: number, b: number) =>
  ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);

export const from565To32 = (v: number) => {
  const r = (v >> 8) & 0xf8, g = (v >> 3) & 0xfc, b = (v << 3) & 0xf8;
  return 0xff000000 | ((b | (b >> 5)) << 16) | ((g | (g >> 6)) << 8) | (r | (r >> 5));
};
export const rgb32 = (r: number, g: number, b: number) => 0xff000000 | (b << 16) | (g << 8) | r;
