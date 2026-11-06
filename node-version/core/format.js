// Number formatting that matches C#'s "N0" (en-US grouping, no decimals), so reason strings read identically.
export const n0 = (x) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(x);
