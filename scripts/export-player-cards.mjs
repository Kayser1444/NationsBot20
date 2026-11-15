import { readFile, writeFile } from 'node:fs/promises';

const source = JSON.parse(await readFile(new URL('../data/cards/library/entries.json', import.meta.url)));
const cards = Object.fromEntries(source.cards.map(card => {
  const facts = Object.fromEntries((card.implementation?.facts ?? []).map(({ field, value }) => [field, value]));
  const amounts = Object.fromEntries(
    [...(facts.production_per_worker ?? facts.production_value ?? '').matchAll(/([+-]?\d+) \[(\w+)\]/g)]
      .map(([, value, resource]) => [resource, Number(value)]),
  );
  const entry = { type: card.type.replaceAll('_', '-'), name: card.name, age: card.age ?? 0 };
  if (Object.keys(amounts).length) entry.amounts = amounts;
  if (facts.deployment_cost) entry.deployCost = -Number(facts.deployment_cost);
  if (facts.raid_value) entry.raid = Number(facts.raid_value);
  if (facts.military_requirement) entry.military = Number(facts.military_requirement);
  if (facts.points) entry.points = Number(facts.points);
  if (facts.stage_costs) entry.stages = [...facts.stage_costs.matchAll(/-?\d+/g)].map(match => Math.abs(Number(match[0])));
  if (facts.private_architects) entry.privateArchitects = Number(facts.private_architects);
  if (facts.penalty_amount) entry.penalty = Math.abs(Number(facts.penalty_amount));
  if (facts.penalty_resource) entry.penaltyResource = facts.penalty_resource.replace(/[\[\]]/g, '');
  if (facts.golden_age_bonus) entry.goldenAgeBonus = Number(facts.golden_age_bonus);
  if (facts.offers_stone) entry.offersStone = facts.offers_stone === 'True';
  if (facts.offers_books) entry.offersBooks = facts.offers_books === 'True';
  if (card.implementation?.description) entry.description = card.implementation.description;
  if (card.implementation?.effects?.length) entry.effects = card.implementation.effects.map(effect => effect.text);
  if (card.printed?.famine !== undefined) entry.famine = Math.abs(card.printed.famine);
  return [card.id, entry];
}));
const rows = Object.entries(cards).sort(([a], [b]) => a.localeCompare(b))
  .map(([id, card]) => `  ${JSON.stringify(id)}: ${JSON.stringify(card)}`);
await writeFile(new URL('../live-player/card-index.json', import.meta.url), `{\n${rows.join(',\n')}\n}\n`);
