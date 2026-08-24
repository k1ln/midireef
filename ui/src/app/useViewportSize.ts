//! Viewport pixel size — only Dashboard needs this (its pan/zoom math scales
//! around the viewport center); every other screen just uses CSS 100%/vw/vh.

import { useEffect, useState } from "react";

export function useViewportSize() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}
