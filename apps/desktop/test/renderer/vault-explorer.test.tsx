import { describe, expect, it } from 'vitest';
import type { IndexedDoc, VaultNode } from '../../shared/ipc';
import {
  filterTreeForLocation,
  isRetrievedPath,
  locationForIndexedDoc,
  locationForState,
} from '../../src/panes/VaultTree';

const file = (relPath: string, state: VaultNode['state']): VaultNode => ({
  name: relPath.split('/').at(-1) ?? relPath,
  path: `/vault/${relPath}`,
  relPath,
  type: 'file',
  state,
});

describe('knowledge file explorer locations', () => {
  it('maps visibility to the three primary locations', () => {
    expect(locationForState('public')).toBe('public');
    expect(locationForState('private')).toBe('private');
    expect(locationForState('local')).toBe('local');
    expect(locationForState('mixed')).toBe('private');
  });

  it('recognizes Retrieved as a path segment on every platform', () => {
    expect(isRetrievedPath('/vault/Retrieved/discord.md')).toBe(true);
    expect(isRetrievedPath('C:\\Vault\\retrieved\\discord.md')).toBe(true);
    expect(isRetrievedPath('/vault/not-retrieved/discord.md')).toBe(false);
  });

  it('places retrieved documents only in Retrieved, regardless of visibility', () => {
    const doc: IndexedDoc = {
      key: 'discord',
      title: 'Discord',
      sourcePath: '/vault/Retrieved/discord.md',
      state: 'private',
      chunkCount: 1,
      chunkIds: ['one'],
      inVault: true,
    };
    expect(locationForIndexedDoc(doc)).toBe('retrieved');
  });

  it('preserves parent folders while filtering files by location', () => {
    const nodes: VaultNode[] = [{
      name: 'Specs',
      path: '/vault/Specs',
      relPath: 'Specs',
      type: 'folder',
      children: [
        file('Specs/public.md', 'public'),
        file('Specs/private.md', 'private'),
      ],
    }];
    const [folder] = filterTreeForLocation(nodes, 'public');
    expect(folder.name).toBe('Specs');
    expect(folder.children?.map(child => child.name)).toEqual(['public.md']);
  });

  it('promotes the physical Retrieved folder contents under the virtual root', () => {
    const nodes: VaultNode[] = [{
      name: 'Retrieved',
      path: '/vault/Retrieved',
      relPath: 'Retrieved',
      type: 'folder',
      children: [file('Retrieved/instagram.md', 'local')],
    }];
    expect(filterTreeForLocation(nodes, 'retrieved').map(node => node.name))
      .toEqual(['instagram.md']);
    expect(filterTreeForLocation(nodes, 'local')).toEqual([]);
  });
});
