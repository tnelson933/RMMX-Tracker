import React from "react";
import Svg, { Circle, Path } from "react-native-svg";

type DirtBikeIconProps = {
  size?: number;
  color?: string;
};

/** Compact motocross-bike mark used for a rider's bike collection. */
export function DirtBikeIcon({ size = 24, color = "#cf152d" }: DirtBikeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx="5.5" cy="17.5" r="3" stroke={color} strokeWidth="1.8" />
      <Circle cx="18.5" cy="17.5" r="3" stroke={color} strokeWidth="1.8" />
      <Path
        d="M5.5 17.5 9 11.5h4.2l2.1 6M9 11.5l2.4 2.7h4.2M13.2 11.5l1.8-3h2.3M15.4 8.5h2.3l1.4 2.2M10.5 8.5h2.7"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}