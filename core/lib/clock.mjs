// All time goes through here so tests can pin RELAY_NOW (ISO string or epoch ms).
export function now() {
  const v = process.env.RELAY_NOW;
  if (!v) return new Date();
  const d = /^\d+$/.test(v) ? new Date(Number(v)) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid RELAY_NOW: ${v}`);
  return d;
}
export const iso = (d = now()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);
