//! React-Entsprechung zu ui/widgets.ts's button() — echtes <button>, Press-
//! Feedback per CSS :active (kein alpha+setTimeout-Hack mehr nötig).

import type { ButtonHTMLAttributes, Ref } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "alt" | "active" | "danger";
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "default", className = "", type = "button", ...rest }: ButtonProps) {
  const variantClass = variant === "default" ? "" : variant;
  return <button type={type} className={["btn", variantClass, className].filter(Boolean).join(" ")} {...rest} />;
}
