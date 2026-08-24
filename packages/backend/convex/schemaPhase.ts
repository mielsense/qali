// The desktop deployer overwrites this module only in its private staged copy.
// Direct development and test deployments always use the contracted schema.
export const schemaPhase = "contract" as "expand" | "contract";
