import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector, Type } from '@y/y';
import { describe, expect, it } from 'vitest';
import { analyzeUpdate } from './update-changes.js';

/** The update `change` makes to a copy of `doc`. */
function changeOf(doc: Doc, change: (copy: Doc) => void): Uint8Array {
  const copy = new Doc();
  applyUpdate(copy, encodeStateAsUpdate(doc));
  const before = encodeStateVector(copy);
  change(copy);
  return encodeStateAsUpdate(copy, before);
}

function changes(doc: Doc, update: Uint8Array) {
  const analysis = analyzeUpdate(doc, update);
  if (!analysis.complete) return 'incomplete';
  return Object.fromEntries([...analysis.changes].map(([root, keys]) => [root, [...keys]]));
}

describe('analyzeUpdate', () => {
  it('COLLAB-SERVER-7.1 names the top-level types and keys an update changes', () => {
    const doc = new Doc();
    doc.get('comments').setAttr('t1', 'first');
    doc.get('body').insert(0, 'hello');

    const edit = changeOf(doc, (copy) => {
      copy.get('body').insert(5, ' world');
      copy.get('comments').setAttr('t1', 'edited');
      copy.get('comments').setAttr('t2', 'new');
    });
    const removal = changeOf(doc, (copy) => copy.get('body').delete(0, 2));

    expect(changes(doc, edit)).toEqual({ body: [null], comments: ['t1', 't2'] });
    expect(changes(doc, removal)).toEqual({ body: [null] });
  });

  it('COLLAB-SERVER-7.1 places a change deep inside a nested type under its top-level key', () => {
    const doc = new Doc();
    doc.get('fields').setAttr('summary', new Type());
    doc.get('fields').setAttr('title', new Type());

    const deep = changeOf(doc, (copy) => {
      const summary = copy.get('fields').getAttr('summary') as Type;
      summary.insert(0, 'nested text');
    });

    expect(changes(doc, deep)).toEqual({ fields: ['summary'] });
  });

  it('COLLAB-SERVER-7.1 reports nothing for content the document holds already', () => {
    const doc = new Doc();
    doc.get('body').insert(0, 'held');

    expect(changes(doc, encodeStateAsUpdate(doc))).toEqual({});
  });

  it('COLLAB-SERVER-7.3 finds an update that builds on content the document lacks', () => {
    const doc = new Doc();
    const writer = new Doc();
    writer.get('body').insert(0, 'a');
    const first = encodeStateAsUpdate(writer);
    const vector = encodeStateVector(writer);
    writer.get('body').insert(1, 'b');
    const second = encodeStateAsUpdate(writer, vector);
    const deletion = (() => {
      const before = encodeStateVector(writer);
      writer.get('body').delete(0, 1);
      return encodeStateAsUpdate(writer, before);
    })();

    expect(changes(doc, second)).toBe('incomplete');
    expect(changes(doc, deletion)).toBe('incomplete');
    expect(changes(doc, first)).toEqual({ body: [null] });
  });
});
