/**
 * Stock riding photos for headers (Race Report without an event photo, My
 * Season, later Home and the racer profile) until riders add their own.
 *
 * React Native's Image has no object-position, so the photo is sized to the
 * container's width and shifted up by `focusY` of its overflow. That keeps
 * the rider's helmet in frame in a wide crop of a tall photo.
 */
import React, { useId, useState } from "react";
import { Image, type ImageSourcePropType, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

/** Dark fade toward the bottom so white text reads on any photo. */
export function PhotoFade({ from = 0.25, strength = 0.88 }: { from?: number; strength?: number }) {
  // Unique gradient id: on web every SVG shares one document, so ids must not repeat.
  const id = `fade${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <Svg style={StyleSheet.absoluteFill} viewBox="0 0 10 10" preserveAspectRatio="none" pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset={from} stopColor="#000" stopOpacity={0} />
          <Stop offset="1" stopColor="#000" stopOpacity={strength} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="10" height="10" fill={`url(#${id})`} />
    </Svg>
  );
}

export interface StockPhoto {
  source: ImageSourcePropType;
  width: number;
  height: number;
  /** 0 = keep the top of the photo, 1 = keep the bottom. */
  focusY: number;
  /** Fraction of the width to trim from the left edge (a dark strip on some photos). */
  trimLeft?: number;
}

export const STOCK_PHOTOS = {
  riderSand: {
    source: require("../assets/images/stock/rider-sand.jpg"),
    width: 399,
    height: 501,
    focusY: 0.18,
    trimLeft: 0.035,
  },
} satisfies Record<string, StockPhoto>;

export function StockBackdrop({ photo = STOCK_PHOTOS.riderSand }: { photo?: StockPhoto }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  let style: object = StyleSheet.absoluteFill;
  if (box) {
    const trim = photo.trimLeft ?? 0;
    const w = box.w / (1 - trim);
    const h = (w * photo.height) / photo.width;
    style = h >= box.h
      ? { position: "absolute", width: w, height: h, left: -w * trim, top: -(h - box.h) * photo.focusY }
      : StyleSheet.absoluteFill;
  }
  return (
    <View
      style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}
      onLayout={e => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      pointerEvents="none"
    >
      {box && <Image source={photo.source} style={style} resizeMode="cover" accessibilityIgnoresInvertColors />}
    </View>
  );
}
