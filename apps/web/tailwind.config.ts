import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"]
      },
      colors: {
        geffen: {
          DEFAULT: "#C9707A",
          50: "#FDF5F6",
          100: "#F5E0E2",
          200: "#EBBFC4",
          300: "#DDA0A7",
          400: "#D4888F",
          500: "#C9707A",
          600: "#B55560",
          700: "#9E4F58",
          800: "#7A3D44",
          900: "#562B30",
        }
      }
    }
  },
  plugins: []
} satisfies Config;
