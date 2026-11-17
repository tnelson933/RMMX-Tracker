import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import React, { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";

import { useColors } from "@/hooks/useColors";
import { goBack } from "@/lib/navigation";
import { handlePaymentReturn } from "@/lib/payments";

/**
 * Where a bank's card check sends the rider back to (rider-app://stripe-redirect,
 * the payment form's return address in lib/payments). Without this screen that
 * link opened "This screen doesn't exist" on top of the registration. It hands
 * the link to Stripe and steps straight back to the screen the rider was on,
 * where the payment form is still waiting.
 */
export default function StripeRedirectScreen() {
  const router = useRouter();
  const colors = useColors();
  const url = Linking.useURL();

  useEffect(() => {
    if (url) handlePaymentReturn(url);
  }, [url]);

  useEffect(() => {
    goBack(router);
  }, [router]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator color={colors.primaryText} size="large" />
    </View>
  );
}
