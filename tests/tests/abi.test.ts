/** abi-equals (architecture §4): the SDK's CouncilManager ABI must equal the compiled one. */

import { describe, expect, it } from 'vitest';
import { COUNCIL_MANAGER_ABI } from '@vocdoni/davinci-dkg-council-sdk';
import type { Abi, AbiParameter } from 'viem';
import { loadArtifact } from '../src/deploy.js';

/** A parameter's type with tuple components expanded; names kept (they shape decoded structs and event args). */
const param = (p: AbiParameter): string => {
  const comps = 'components' in p && p.components ? `(${p.components.map(param).join(',')})` : '';
  const indexed = 'indexed' in p && p.indexed ? ' indexed' : '';
  return `${p.type}${comps}${indexed} ${p.name ?? ''}`.trim();
};

const unnamed = (p: AbiParameter): string => param({ ...p, name: '' } as AbiParameter);

/**
 * One canonical line per ABI item. Top-level function parameter and return names do not
 * affect encoding and are dropped; struct component names (decoded object keys) and event
 * argument names are kept.
 */
function normalize(abi: Abi): string[] {
  return abi
    .map((item) => {
      switch (item.type) {
        case 'function': {
          const inputs = item.inputs.map(unnamed).join(',');
          return `function ${item.name}(${inputs}) ${item.stateMutability} returns (${item.outputs.map(unnamed).join(',')})`;
        }
        case 'event':
          return `event ${item.name}(${item.inputs.map(param).join(',')})`;
        case 'error':
          return `error ${item.name}(${item.inputs.map(param).join(',')})`;
        case 'constructor':
          return `constructor(${item.inputs.map(unnamed).join(',')})`;
        default:
          return item.type;
      }
    })
    .sort();
}

const diff = (a: string[], b: string[]): string[] => a.filter((l) => !b.includes(l));

describe('SDK ABI vs the compiled manager surface', () => {
  // EIP-170 split: one address serves CouncilManager's functions and, through its fallback,
  // CouncilViews' and CouncilOps'. ICouncil declares the union; the errors live in the
  // implementations.
  const iface = loadArtifact('ICouncil.sol', 'ICouncil').abi;
  const manager = loadArtifact('CouncilManager.sol', 'CouncilManager').abi;
  const views = loadArtifact('CouncilViews.sol', 'CouncilViews').abi;
  const ops = loadArtifact('CouncilOps.sol', 'CouncilOps').abi;

  it('ICouncil declares exactly what CouncilManager, CouncilViews and CouncilOps implement', () => {
    const surface = normalize(iface);
    const implemented = normalize(
      [...manager, ...views, ...ops].filter((x) => x.type === 'function' || x.type === 'event') as Abi,
    );
    expect({ notDeclared: diff(implemented, surface), notImplemented: diff(surface, implemented) }).toEqual({
      notDeclared: [],
      notImplemented: [],
    });
  });

  it('the SDK ABI equals ICouncil plus the implementation errors, in both directions', () => {
    const errors = [...manager, ...views, ...ops].filter((x) => x.type === 'error');
    const compiled = [...new Set(normalize([...iface, ...errors] as Abi))];
    const sdk = normalize(COUNCIL_MANAGER_ABI as Abi);
    expect({ missingFromSdk: diff(compiled, sdk), unknownToContract: diff(sdk, compiled) }).toEqual({
      missingFromSdk: [],
      unknownToContract: [],
    });
  });
});
