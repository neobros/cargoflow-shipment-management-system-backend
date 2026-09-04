/**
 * Code 128 subset B, rendered as SVG.
 *
 * A shipping label's barcode has to survive a handheld scanner at an angle, in
 * a warehouse, on a box that has been in a truck — so it has to be a real
 * symbology with a real check digit, not a decorative pattern. Code 128B covers
 * the printable ASCII our tracking IDs use, is what every warehouse scanner
 * reads without configuration, and encodes densely enough to fit across a
 * 100 mm label at a scannable module width.
 *
 * SVG rather than a raster: it prints crisply at whatever DPI the depot's label
 * printer runs at, and a barcode resampled to a printer's native resolution is
 * a barcode that intermittently fails to scan.
 */

/**
 * The 107 bar/space width patterns, indexed by symbol value. Each digit is the
 * width of one element in modules, alternating bar, space, bar, space…
 * Value 106 is the stop pattern and carries a seventh element.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const START_B = 104;
const STOP = 106;

/** Symbol values for the payload, in subset B: printable ASCII less 32. */
const encodeValues = (text: string): number[] => {
  const values: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw new Error(`Code 128B cannot encode ${JSON.stringify(char)}`);
    }
    values.push(code - 32);
  }
  return values;
};

/**
 * Modulo-103 weighted checksum. The start value counts once, then each payload
 * symbol is weighted by its 1-based position. Without it a single misread bar
 * silently becomes a different, valid-looking tracking ID.
 */
const checksum = (values: number[]): number => {
  let sum = START_B;
  values.forEach((value, index) => {
    sum += value * (index + 1);
  });
  return sum % 103;
};

export interface BarcodeOptions {
  /** Width of the narrowest bar. Below ~0.25 mm most handhelds start failing. */
  moduleWidth?: number;
  height?: number;
  /** Blank space each side. The spec wants at least 10 modules. */
  quietZone?: number;
}

export interface Barcode {
  svg: string;
  width: number;
  height: number;
  /** The exact string encoded, so a caller can print it under the bars. */
  value: string;
}

export const code128 = (text: string, options: BarcodeOptions = {}): Barcode => {
  const moduleWidth = options.moduleWidth ?? 2;
  const height = options.height ?? 70;
  const quietZone = options.quietZone ?? 10;

  const values = encodeValues(text);
  const symbols = [START_B, ...values, checksum(values), STOP];

  const bars: { x: number; width: number }[] = [];
  let cursor = quietZone;

  for (const symbol of symbols) {
    const pattern = PATTERNS[symbol];
    if (!pattern) throw new Error(`No Code 128 pattern for symbol ${symbol}`);

    // Odd positions are bars, even are spaces. Both advance the cursor; only
    // bars are drawn.
    for (let i = 0; i < pattern.length; i += 1) {
      const width = Number(pattern[i]);
      if (i % 2 === 0) bars.push({ x: cursor, width });
      cursor += width;
    }
  }

  const totalModules = cursor + quietZone;
  const width = totalModules * moduleWidth;

  const rects = bars
    .map(
      (bar) =>
        `<rect x="${(bar.x * moduleWidth).toFixed(2)}" y="0" width="${(
          bar.width * moduleWidth
        ).toFixed(2)}" height="${height}" />`,
    )
    .join('');

  return {
    svg:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(2)}" height="${height}" ` +
      `viewBox="0 0 ${width.toFixed(2)} ${height}" role="img" aria-label="Barcode ${text}">` +
      `<rect width="100%" height="100%" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>`,
    width,
    height,
    value: text,
  };
};
