/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // taken from the drippy logo
        water: { light: '#8ec3e3', DEFAULT: '#5b9fd0', deep: '#4d73ad', ink: '#2f4c7a' },
        sky: { DEFAULT: '#eaf5fc', soft: '#f5fbff' },
        // one colour per meaning: money lost, savings, time
        coral: { light: '#ffd6cc', DEFAULT: '#f2735a', deep: '#c94f39' },
        leaf: { light: '#d4f2d9', DEFAULT: '#4cb871', deep: '#2f8a50' },
        sun: { light: '#fff1c2', DEFAULT: '#f6c344', deep: '#b8860b' },
      },
      fontFamily: {
        sans: ['Fredoka', 'ui-rounded', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        chunky: '0 4px 0 0 #4d73ad',
      },
    },
  },
  plugins: [],
};
