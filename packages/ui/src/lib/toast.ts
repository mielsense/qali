import {
  AlertCircleIcon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createElement } from "react";
import { sileo, type SileoOptions } from "sileo";

export interface ToastPresentation {
  severity: "success" | "info" | "error";
  title: string;
  description: string;
  duration: number;
}

type ToastDetails = Omit<SileoOptions, "title" | "type">;

const severityIcons = {
  success: CheckmarkCircle02Icon,
  info: InformationCircleIcon,
  error: AlertCircleIcon,
} as const;

/** UI-only Sileo boundary. Product code emits a Qali notice instead. */
export function showToast(presentation: ToastPresentation): string {
  const options: SileoOptions = {
    title: presentation.title,
    description: presentation.description,
    duration: presentation.duration,
    icon: createElement(HugeiconsIcon, {
      icon: severityIcons[presentation.severity],
      strokeWidth: 2,
      className: "size-4",
    }),
  };

  return sileo[presentation.severity](options);
}

function legacyOptions(
  title: string,
  details?: ToastDetails,
): SileoOptions {
  return { title, ...details };
}

/**
 * @deprecated Product code should emit a typed notice. Retained for consumers
 * outside the Qali workspace migration until they adopt their own adapter.
 */
export const toast = Object.freeze({
  success: (title: string, details?: ToastDetails) =>
    sileo.success(legacyOptions(title, details)),
  error: (title: string, details?: ToastDetails) =>
    sileo.error(legacyOptions(title, details)),
  warning: (title: string, details?: ToastDetails) =>
    sileo.warning(legacyOptions(title, details)),
  info: (title: string, details?: ToastDetails) =>
    sileo.info(legacyOptions(title, details)),
  dismiss: sileo.dismiss,
  clear: sileo.clear,
});
