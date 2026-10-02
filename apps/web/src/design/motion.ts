import type { Transition, Variants } from "motion/react";

export const easeOut = [0.33, 1, 0.68, 1] as const;
export const easeInOut = [0.65, 0, 0.35, 1] as const;

export const focusIn: Variants = {
  hidden: { opacity: 0, filter: "blur(2px)", y: 6 },
  show: { opacity: 1, filter: "blur(0px)", y: 0, transition: { duration: 0.6, ease: easeOut } },
};

export const stagger = (step = 0.04, delay = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: step, delayChildren: delay } },
});

export const inView = { initial: "hidden", whileInView: "show", viewport: { once: true, amount: 0.3 } } as const;

export const spring: Transition = { type: "spring", stiffness: 500, damping: 40, mass: 0.8 };
export const softSpring: Transition = { type: "spring", stiffness: 260, damping: 32 };
