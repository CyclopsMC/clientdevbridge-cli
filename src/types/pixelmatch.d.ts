/**
 * pixelmatch 6 ships as plain JavaScript with no bundled types, and there is no
 * @types/pixelmatch for it. Only the surface `compare` actually uses is declared here.
 */
declare module 'pixelmatch' {
  interface PixelmatchOptions {
    /** Matching threshold, 0 to 1; smaller is stricter. Default 0.1. */
    threshold?: number;
    includeAA?: boolean;
    alpha?: number;
    aaColor?: [number, number, number];
    diffColor?: [number, number, number];
    diffColorAlt?: [number, number, number];
    diffMask?: boolean;
  }

  /** Returns the number of differing pixels, and writes a visual diff into `output`. */
  export default function pixelmatch(
    img1: Uint8Array | Buffer,
    img2: Uint8Array | Buffer,
    output: Uint8Array | Buffer | null,
    width: number,
    height: number,
    options?: PixelmatchOptions,
  ): number;
}
