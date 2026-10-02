import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
export const newId = customAlphabet(alphabet, 16);
export const shortId = customAlphabet(alphabet, 8);
