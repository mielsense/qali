/** Desktop builds authenticate only through the main-process local issuer. */
export const authClient = Object.freeze({
  useSession: () => ({ data: null, error: null, isPending: false }),
  signOut: async () => ({ data: null, error: null }),
});
