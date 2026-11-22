// Matches Tabony's threshold and tie rules, including its caps and zero floor.
export function mostLeast(values) {
  if (values.length < 2) throw new Error('At least two nations are required.');
  const width = values.length >= 5 ? 2 : 1;
  const sorted = values.toSorted((a, b) => a - b);
  let most = Math.max(0, sorted.at(-width));
  if (sorted.at(-width - 1) === most) most++;
  const least = Math.max(-1, sorted[width - 1]);
  return { most: values.map(value => value >= most), least: values.map(value => value <= least) };
}

export function boundedResource(name, value) {
  return name === 'Stability' ? Math.min(15, value) : name === 'Military' ? Math.min(40, value) : value;
}
