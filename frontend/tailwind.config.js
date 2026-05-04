/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // V.I.C.T.O.R. clinical dark palette — original direction.
        ink: {
          900: "#0a0d12",
          800: "#11151c",
          700: "#171c25",
          600: "#1f2531",
          500: "#2a3140",
        },
        bone: {
          50:  "#f5f4ef",
          100: "#e8e6df",
          200: "#c9c6bb",
          400: "#8a8a82",
        },
        signal: {
          // Restrained accent — used only for active state + concordance flag.
          DEFAULT: "#d4a574",  // warm amber
          high: "#e8b487",
          low: "#a37c4f",
        },
        flag: "#c2543d",       // Tier 1/2 concordance — never used decoratively
        ok:   "#7a9a6f",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
