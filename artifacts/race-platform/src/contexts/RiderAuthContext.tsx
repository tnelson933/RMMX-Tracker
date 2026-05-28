import { createContext, useContext, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { riderApi, type RiderAccount } from "@/lib/rider-api";

interface RiderAuthContextType {
  account: RiderAccount | null;
  isLoading: boolean;
  isAuthenticated: boolean;
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
    isAuthenticated: !!account,
    invalidate: () => queryClient.invalidateQueries({ queryKey: ["rider-auth-me"] }),
  };

  return <RiderAuthContext.Provider value={value}>{children}</RiderAuthContext.Provider>;
}

export function useRiderAuth() {
  const ctx = useContext(RiderAuthContext);
  if (!ctx) throw new Error("useRiderAuth must be used within RiderAuthProvider");
  return ctx;
}
