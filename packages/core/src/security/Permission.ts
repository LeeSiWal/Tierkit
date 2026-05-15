import { z } from "zod";

export const PERMISSIONS = [
  "readFiles",
  "editFiles",
  "runCommands",
  "registerMcp",
  "useLocalDeviceModel",
  "usePrivateRemoteModel",
  "usePublicCloudModel",
  "accessSecrets",
  "modifyAgentSettings",
  "installDependencies",
  "useNetwork",
] as const;

export type TierkitPermission = (typeof PERMISSIONS)[number];

export const PermissionFlagsSchema = z
  .object({
    readFiles: z.boolean().default(false),
    editFiles: z.boolean().default(false),
    runCommands: z.boolean().default(false),
    registerMcp: z.boolean().default(false),
    useLocalDeviceModel: z.boolean().default(true),
    usePrivateRemoteModel: z.boolean().default(false),
    usePublicCloudModel: z.boolean().default(false),
    accessSecrets: z.boolean().default(false),
    modifyAgentSettings: z.boolean().default(false),
    installDependencies: z.boolean().default(false),
    useNetwork: z.boolean().default(false),
  })
  .strict();

export type PermissionFlags = z.infer<typeof PermissionFlagsSchema>;

export const HIGH_RISK_PERMISSIONS: readonly TierkitPermission[] = [
  "runCommands",
  "registerMcp",
  "accessSecrets",
  "modifyAgentSettings",
  "installDependencies",
  "usePublicCloudModel",
];

export function listGrantedPermissions(flags: PermissionFlags): TierkitPermission[] {
  return PERMISSIONS.filter((p) => flags[p]);
}

export function listHighRiskGranted(flags: PermissionFlags): TierkitPermission[] {
  return HIGH_RISK_PERMISSIONS.filter((p) => flags[p]);
}
