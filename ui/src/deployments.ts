/**
 * The deployments one copy of the app serves: the current manager (new committees) and legacy
 * managers on the same chain whose committees are still open, so their kits and links keep
 * working on the same origin. Each gets its own services (client bound to its manager, its own
 * relayers); everything else — chain, providers, artifact mirrors — is shared.
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { legacyConfig, type AppConfig } from './config';
import { buildServices, type Services } from './services';

/** One deployment this copy of the app serves (protocol: one manager on the app's chain). */
export interface DeploymentRef {
  manager: Hex;
  /** Operator's name for an older deployment; display only. */
  label?: string;
  /** Not the current deployment (no new committees; kits and links of older ones keep working). */
  legacy: boolean;
}

/** Every deployment this copy serves: the current one first, then the legacy ones. */
export interface Deployments {
  current: Services;
  list: DeploymentRef[];
  /** Services bound to `manager` (built once), or undefined when this copy does not serve it. */
  forManager(manager: Hex): Services | undefined;
}

/** The deployments of a config; legacy services are built on first use. */
export function buildDeployments(config: AppConfig, build: (c: AppConfig) => Services = buildServices): Deployments {
  const current = build(config);
  const built = new Map<string, Services>([[config.manager.toLowerCase(), current]]);
  const list: DeploymentRef[] = [
    { manager: config.manager, legacy: false },
    ...config.legacyDeployments.map((d) => ({ manager: d.manager, legacy: true, ...(d.label ? { label: d.label } : {}) })),
  ];
  return {
    current,
    list,
    forManager: (manager) => {
      const key = manager.toLowerCase();
      const hit = built.get(key);
      if (hit) return hit;
      const legacy = config.legacyDeployments.find((d) => d.manager.toLowerCase() === key);
      if (!legacy) return undefined;
      const services = build(legacyConfig(config, legacy));
      built.set(key, services);
      return services;
    },
  };
}

/** A single deployment (tests, and any setup without legacy managers). */
export function singleDeployment(services: Services): Deployments {
  return {
    current: services,
    list: [{ manager: services.config.manager, legacy: false }],
    forManager: (manager) =>
      manager.toLowerCase() === services.config.manager.toLowerCase() ? services : undefined,
  };
}


/** Retry interval of a committee lookup that could not read every deployment (tests shorten it). */
export const probeTiming = { retryMs: 8000 };
