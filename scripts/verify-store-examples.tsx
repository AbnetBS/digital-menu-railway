import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import StoreExamples from '../src/components/rms/StoreExamples';

const html = renderToStaticMarkup(<StoreExamples onDismiss={() => {}} />);
for (const name of ['Roasted coffee beans', 'Fresh milk', 'Eggs'])
  assert.ok(html.includes(name));
assert.ok(html.includes('Remove examples'));
assert.ok(html.includes('not your actual stock'));
assert.ok(html.includes('cannot be requested or used in recipes'));
for (const file of ['coffee.jpg', 'milk.jpg', 'eggs.jpg'])
  assert.ok(existsSync('public/store-examples/' + file));
const page = readFileSync('src/app/(internal)/store/page.tsx', 'utf8');
assert.ok(
  page.includes(
    'data.who.manager && data.items.length === 0 && !examplesHidden',
  ),
);
assert.match(page, /localStorage\.setItem\(\s*'fana-store-hide-examples',\s*'1'/);
const schema = readFileSync('src/lib/store/schema.ts', 'utf8');
assert.ok(
  !schema.includes('store-examples/'),
  'example cards must not create database stock',
);
console.log(
  'Store examples guard PASSED: display-only illustrations, empty inventory, dismissal and no seeded stock',
);
