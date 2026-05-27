import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLogin, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { ShieldAlert, KeyRound } from "lucide-react";
import rmLogo from "@assets/rm-logo.png";
import { Alert, AlertDescription } from "@/components/ui/alert";

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email address." }),
  password: z.string().min(1, { message: "Password is required." }),
  rememberMe: z.boolean().default(false),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const loginMutation = useLogin();
  const { isAuthenticated } = useAuth();
  const [authError, setAuthError] = useState<string | null>(null);

  // Navigate as soon as auth state confirms login — avoids race condition where
  // setLocation fires before AuthContext re-renders with the new user data.
  useEffect(() => {
    if (isAuthenticated) setLocation("/dashboard");
  }, [isAuthenticated, setLocation]);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
      rememberMe: false,
    },
  });

  const onSubmit = (data: LoginFormValues) => {
    setAuthError(null);
    loginMutation.mutate(
      { data: { email: data.email, password: data.password, rememberMe: data.rememberMe } },
      {
        onSuccess: async () => {
          await queryClient.refetchQueries({ queryKey: getGetMeQueryKey() });
          // Navigation is handled by the useEffect above once isAuthenticated flips true
        },
        onError: (error: any) => {
          setAuthError(error?.message || "Invalid email or password. Please try again.");
        },
      }
    );
  };

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center p-4 bg-sidebar/5 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl -z-10 pointer-events-none"></div>
      
      <Card className="w-full max-w-md shadow-2xl border-sidebar-border/20">
        <div className="bg-sidebar p-8 text-center border-b border-sidebar-border relative overflow-hidden">
          <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjMWExYTFhIj48L3JlY3Q+CjxwYXRoIGQ9Ik0wIDBMOCA4Wk04IDBMMCA4WiIgc3Ryb2tlPSIjMjI0IiBzdHJva2Utd2lkdGg9IjEiPjwvcGF0aD4KPC9zdmc+')] opacity-20"></div>
          <img src={rmLogo} alt="Rocky Mountain" className="w-16 h-16 mx-auto mb-4 relative z-10 drop-shadow-lg" />
          <CardTitle className="text-3xl font-heading font-bold uppercase tracking-tight text-sidebar-foreground relative z-10">
            Organizer Portal
          </CardTitle>
          <CardDescription className="text-sidebar-foreground/70 mt-2 relative z-10 text-base">
            Secure login for club officials and track staff
          </CardDescription>
        </div>
        
        <CardContent className="p-8">
          {authError && (
            <Alert variant="destructive" className="mb-6 rounded-sm">
              <AlertDescription className="font-medium text-sm flex items-center gap-2">
                <ShieldAlert size={16} />
                {authError}
              </AlertDescription>
            </Alert>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-heading uppercase tracking-wider text-muted-foreground font-bold">Email Address</FormLabel>
                    <FormControl>
                      <Input 
                        placeholder="official@club.com" 
                        {...field} 
                        className="h-12 bg-muted/50 focus:bg-background border-muted-foreground/20 text-lg font-medium"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-heading uppercase tracking-wider text-muted-foreground font-bold">Password</FormLabel>
                    <FormControl>
                      <Input 
                        type="password" 
                        placeholder="••••••••" 
                        {...field} 
                        className="h-12 bg-muted/50 focus:bg-background border-muted-foreground/20 text-lg tracking-widest font-mono"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="rememberMe"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        id="rememberMe"
                        className="border-muted-foreground/40 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                      />
                    </FormControl>
                    <label
                      htmlFor="rememberMe"
                      className="text-sm font-medium text-muted-foreground cursor-pointer select-none leading-none"
                    >
                      Remember me for 30 days
                    </label>
                  </FormItem>
                )}
              />

              <Button 
                type="submit" 
                className="w-full h-14 text-lg font-heading font-bold uppercase tracking-widest mt-2"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></span>
                    Authenticating...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <KeyRound size={20} /> Authorize Access
                  </span>
                )}
              </Button>
            </form>
          </Form>
        </CardContent>
        <CardFooter className="bg-muted/30 border-t p-6 text-center text-sm text-muted-foreground font-medium flex flex-col gap-2">
          <span>Authorized personnel only. All access is logged.</span>
          <a href="/setup-account" className="text-primary hover:underline font-semibold">
            First time signing in? Set up your account →
          </a>
        </CardFooter>
      </Card>
    </div>
  );
}
