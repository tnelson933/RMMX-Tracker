import { createContext, useContext, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { riderApi, type RiderAccount } from "@/lib/rider-api";

interface RiderAuthContextType {
  account: RiderAccount | null;
  isLoading: boolean;
  /** Signed in with a verified email. */
  isAuthenticated: boolean;
  /** Signed in, but the email isn't confirmed yet: the sign-in page asks for the code. */
  needsVerification: boolean;
  invalidate: () => void;
}

const RiderAuthContext = createContext<RiderAuthContextType | undefined>(undefined);

export function RiderAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data: account, isLoading } = useQuery<RiderAccount>({
    queryKey: ["rider-auth-me"],
    queryFn: () => riderApi.me(),
    retry: false,
    staleTime: 60_000,
  } as any);

  const value: RiderAuthContextType = {
    account: account ?? null,
    isLoading,
    // Older servers don't send emailVerified: treat that as verified.
    isAuthenticated: !!account && account.emailVerified !== false,
    needsVerification: !!account && account.emailVerified === false,
    invalidate: () => queryClient.invalidateQueries({ queryKey: ["rider-auth-me"] }),
  };

  return <RiderAuthContext.Provider value={value}>{children}</RiderAuthContext.Provider>;
}

export function useRiderAuth() {
  const ctx = useContext(RiderAuthContext);
  if (!ctx) throw new Error("useRiderAuth must be used within RiderAuthProvider");
  return ctx;
}
