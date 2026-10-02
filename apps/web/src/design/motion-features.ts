// Animation features for <LazyMotion> (main.tsx), loaded as a separate chunk so they stay out of the main bundle.
// domMax rather than domAnimation: the nav pills, tabs and the benchmark table's focus outline use layout animations.
export { domMax as default } from "motion/react";
