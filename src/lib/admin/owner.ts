export type AdminOwner = { accountId: string; robloxUserId: number };

// Approval is restricted to this verified identity; environment values cannot broaden it.
const APPROVED_ACCOUNT_ID = "b90e15ba-7711-437d-b0ce-4f563197da20";
const APPROVED_ROBLOX_ID = 142277800;
export function adminOwnerConfig(environment: Record<string, string | undefined> = process.env): AdminOwner | null {
  return environment.ROMANUM_ADMIN_ACCOUNT_ID === APPROVED_ACCOUNT_ID
    && environment.ROMANUM_ADMIN_ROBLOX_USER_ID === String(APPROVED_ROBLOX_ID)
    ? { accountId: APPROVED_ACCOUNT_ID, robloxUserId: APPROVED_ROBLOX_ID } : null;
}
export function isAdminOwner(account: { id: string; robloxUserId: number } | null, owner: AdminOwner | null) {
  return !!account && !!owner && account.id === owner.accountId && account.robloxUserId === owner.robloxUserId;
}
