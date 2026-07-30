import { CodeReviewGraphProvider } from "@veriflow/provider-crg";
import type { CodeIntelligenceProvider } from "@veriflow/provider-protocol";

/**
 * The composition root for code intelligence providers, and the only place besides an adapter's own
 * package that is allowed to name one. Everything else asks for a provider by configuration and gets
 * back the protocol — which is what makes "replace the provider" an adapter change and nothing more.
 */

export const DEFAULT_PROVIDER_ID = "code-review-graph";

export interface ProviderFactoryOptions {
  command?: string;
}

export function createProvider(
  id: string = DEFAULT_PROVIDER_ID,
  options: ProviderFactoryOptions = {},
): CodeIntelligenceProvider {
  switch (id) {
    case "code-review-graph":
      return new CodeReviewGraphProvider(options);
    default:
      throw new Error(`unknown code intelligence provider: ${id}`);
  }
}

export const KNOWN_PROVIDER_IDS = [DEFAULT_PROVIDER_ID] as const;
