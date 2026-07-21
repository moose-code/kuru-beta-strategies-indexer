import { indexer } from "envio";
/**
 * EventHandlers.ts
 *
 * Handlers for:
 *   VaultFactory  → VaultCreated
 *   QuoteOnlyVault → Deposit | Withdraw | Rebalance | Rebalanced
 *
 * Each QuoteOnlyVault event triggers an eth_call (totalAssets + totalSupply)
 * at the event's own block number and writes a SharePricePoint to the DB.
 * Dynamic contract registration ensures every newly-created clone is
 * automatically indexed without touching the config.
 */

import {
  VaultFactory,
  QuoteOnlyVault,
} from "../generated/index.js";
import type {
  VaultFactory_VaultCreated_event,
  QuoteOnlyVault_Deposit_event,
  QuoteOnlyVault_Withdraw_event,
  QuoteOnlyVault_Rebalance_event,
  QuoteOnlyVault_Rebalanced_event,
} from "../generated/src/Types.gen.js";

import { snapshotVault } from "./utils";
// Import block handler to register the periodic snapshot handler
import "./BlockHandler.js";

// ---------------------------------------------------------------------------
// VaultFactory.VaultCreated
// ---------------------------------------------------------------------------
indexer.onEvent(
  { contract: "VaultFactory", event: "VaultCreated" },
  async ({
    event,
    context,
  }: {
    event: VaultFactory_VaultCreated_event;
    context: any;
  }) => {
    const vaultAddr = event.params.vault.toLowerCase();
    const userAddr = event.params.user.toLowerCase();
    const factoryAddr = event.srcAddress.toLowerCase();

    // 1. Create the Vault entity.
    context.Vault.set({
      id: vaultAddr,
      user: userAddr,
      factory: factoryAddr,
      createdAt: BigInt(event.block.timestamp),
      createdAtBlock: BigInt(event.block.number),
      isActive: true,
      latestSharePriceE18: undefined,
      latestTvl: undefined,
      latestSnapshotBlock: undefined,
    });

    // 2. Create or update the VaultRegistry singleton for this factory.
    //    The block handler reads this to iterate all known vaults.
    const registry = await context.VaultRegistry.get(factoryAddr);
    const existing: string[] = registry
      ? JSON.parse(registry.vaultAddresses)
      : [];
    const updated = [...existing, vaultAddr];

    context.VaultRegistry.set({
      id: factoryAddr,
      factory: factoryAddr,
      vaultAddresses: JSON.stringify(updated),
      count: updated.length,
    });

    // 3. Register the new clone so Envio starts indexing its events.
    //    All future Deposit / Withdraw / Rebalance / Rebalanced events on
    //    this address will be routed to the QuoteOnlyVault handlers below.
    // Note: In Envio v3, context doesn't have addNewContractRegistration.
    // Dynamic registration is done via .contractRegister() callback instead.
  }
);

// Register dynamic contracts: whenever a VaultCreated event is detected,
// automatically start indexing that vault's events.
indexer.contractRegister(
  { contract: "VaultFactory", event: "VaultCreated" },
  async ({ event, context }) => {
  context.chain.QuoteOnlyVault.add(event.params.vault);
}
);

// ---------------------------------------------------------------------------
// QuoteOnlyVault.Deposit
// ---------------------------------------------------------------------------
indexer.onEvent(
  { contract: "QuoteOnlyVault", event: "Deposit" },
  async ({
    event,
    context,
  }: {
    event: QuoteOnlyVault_Deposit_event;
    context: any;
  }) => {
    const vaultAddr = event.srcAddress.toLowerCase();
    const userAddr = event.params.user.toLowerCase();
    const blockNumber = BigInt(event.block.number);
    const timestamp = BigInt(event.block.timestamp);

    // Snapshot share price at this exact block.
    await snapshotVault(vaultAddr, blockNumber, timestamp, "Deposit", context);

    // Update user position.
    const positionId = `${userAddr}-${vaultAddr}`;
    const existing = await context.UserPosition.get(positionId);
    context.UserPosition.set({
      id: positionId,
      user: userAddr,
      vault_id: vaultAddr,
      totalQuoteDeposited:
        (existing?.totalQuoteDeposited ?? 0n) + event.params.quoteAmount,
      totalQuoteWithdrawn: existing?.totalQuoteWithdrawn ?? 0n,
      totalBaseReturned: existing?.totalBaseReturned ?? 0n,
      currentShares:
        (existing?.currentShares ?? 0n) + event.params.sharesMinted,
      lastUpdatedAt: timestamp,
    });
  }
);

// ---------------------------------------------------------------------------
// QuoteOnlyVault.Withdraw
// ---------------------------------------------------------------------------
indexer.onEvent(
  { contract: "QuoteOnlyVault", event: "Withdraw" },
  async ({
    event,
    context,
  }: {
    event: QuoteOnlyVault_Withdraw_event;
    context: any;
  }) => {
    const vaultAddr = event.srcAddress.toLowerCase();
    const userAddr = event.params.user.toLowerCase();
    const blockNumber = BigInt(event.block.number);
    const timestamp = BigInt(event.block.timestamp);

    await snapshotVault(vaultAddr, blockNumber, timestamp, "Withdraw", context);

    const positionId = `${userAddr}-${vaultAddr}`;
    const existing = await context.UserPosition.get(positionId);

    // currentShares is always non-negative in practice (user burns what they own).
    // Guard against DB inconsistency just in case.
    const prevShares = existing?.currentShares ?? 0n;
    const burned = event.params.sharesBurned;
    const currentShares = prevShares >= burned ? prevShares - burned : 0n;

    context.UserPosition.set({
      id: positionId,
      user: userAddr,
      vault_id: vaultAddr,
      totalQuoteDeposited: existing?.totalQuoteDeposited ?? 0n,
      totalQuoteWithdrawn:
        (existing?.totalQuoteWithdrawn ?? 0n) + event.params.quoteReturned,
      totalBaseReturned:
        (existing?.totalBaseReturned ?? 0n) + event.params.baseReturned,
      currentShares,
      lastUpdatedAt: timestamp,
    });

    // Mark vault inactive when all shares are burned (full withdrawal).
    if (currentShares === 0n) {
      const vault = await context.Vault.get(vaultAddr);
      if (vault) {
        context.Vault.set({ ...vault, isActive: false });
      }
    }
  }
);

// ---------------------------------------------------------------------------
// QuoteOnlyVault.Rebalance  (owner-initiated relever)
// ---------------------------------------------------------------------------
indexer.onEvent(
  { contract: "QuoteOnlyVault", event: "Rebalance" },
  async ({
    event,
    context,
  }: {
    event: QuoteOnlyVault_Rebalance_event;
    context: any;
  }) => {
    await snapshotVault(
      event.srcAddress.toLowerCase(),
      BigInt(event.block.number),
      BigInt(event.block.timestamp),
      "Rebalance",
      context
    );
  }
);

// ---------------------------------------------------------------------------
// QuoteOnlyVault.Rebalanced  (permissionless external rebalancer)
// ---------------------------------------------------------------------------
indexer.onEvent(
  { contract: "QuoteOnlyVault", event: "Rebalanced" },
  async ({
    event,
    context,
  }: {
    event: QuoteOnlyVault_Rebalanced_event;
    context: any;
  }) => {
    await snapshotVault(
      event.srcAddress.toLowerCase(),
      BigInt(event.block.number),
      BigInt(event.block.timestamp),
      "Rebalanced",
      context
    );
  }
);

// Export a dummy value to ensure this module is loaded as an ES module.
// Envio requires at least one export from handler files.
export {};
