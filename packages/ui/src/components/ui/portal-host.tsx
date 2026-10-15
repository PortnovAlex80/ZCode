import { createContext, useContext } from "react";

/** Menus/dialogs follow the actual presentation document after native detachment. */
export const PortalHostContext = createContext<HTMLElement | undefined>(undefined);
export function usePortalHost(): HTMLElement | undefined {
  return useContext(PortalHostContext);
}
