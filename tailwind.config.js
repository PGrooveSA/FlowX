/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        primary: { DEFAULT: 'rgb(var(--primary) / <alpha-value>)', foreground: 'hsl(var(--primary-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        sky: { DEFAULT: 'rgb(var(--sky) / <alpha-value>)', bg: '#e8f6fe' },
        ink: { DEFAULT: '#1d1d1b', 2: '#474d55' },
      },
      borderRadius: { lg: '1.25rem', md: '0.875rem', sm: '0.25rem' },
      fontFamily: { sans: ['Outfit', 'Segoe UI', 'system-ui', 'Roboto', 'sans-serif'] },
    },
  },
  plugins: [],
};
