# UI Components

This directory contains reusable UI components following the shadcn/ui structure.

## RotatingText Component

An animated text component that cycles through words with various animation modes.

### Usage

```tsx
import { RotatingText } from "@/components/ui/rotating-text";

function MyComponent() {
  return (
    <h1>
      Build{" "}
      <RotatingText
        words={["faster", "better", "smarter"]}
        mode="slide"
        interval={2500}
        className="text-primary"
      />
    </h1>
  );
}
```

### Props

- `words: string[]` - Array of words to rotate through (required)
- `interval?: number` - Time in milliseconds between rotations (default: 2500)
- `mode?: "slide" | "fade" | "blur" | "flip" | "drop"` - Animation mode (default: "slide")
- `className?: string` - Additional CSS classes

### Animation Modes

- **slide** - Words slide up/down
- **fade** - Words fade in/out
- **blur** - Words blur in/out
- **flip** - Words flip on 3D axis
- **drop** - Words drop down with scale

### Example

See `rotating-text-demo.tsx` for a complete example showcasing all animation modes.
