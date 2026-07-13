# Mobile/Responsive QA Testing (Task 4/7)

## Overview
Comprehensive QA testing plan for FocusBro across mobile, tablet, and desktop breakpoints.
Tests responsive CSS, touch interactions, ambient controls, and billing flows.

## Testing Breakpoints

| Device | Width | Test Priority |
|--------|-------|---|
| **Mobile (Small)** | 320px | P0 - Critical |
| **Mobile (Large)** | 480px | P0 - Critical |
| **Tablet (Portrait)** | 768px | P1 - High |
| **Tablet (Landscape)** | 1024px | P1 - High |
| **Desktop** | 1280px+ | P2 - Medium |

## Quick Reference: CSS Breakpoints
```css
/* Mobile-first approach in index.html */
@media (max-width: 480px) { /* Mobile small */ }
@media (max-width: 768px) { /* Mobile large / tablet portrait */ }
@media (max-width: 1024px) { /* Tablet landscape */ }
@media (min-width: 1024px) { /* Desktop */ }
```

---

## Test Categories

### 1. Layout & Typography (All Breakpoints)

#### 480px Mobile (Critical)
- [ ] Logo/header fits without truncation
- [ ] Navigation hamburger menu visible & functional
- [ ] Main content area not constrained by padding (min 16px each side)
- [ ] Gallery hero section displays at good height (check for 380px target)
- [ ] Text is readable without zoom (16px+ body, 20px+ headings)
- [ ] Buttons have min 48px height for touch targets
- [ ] No horizontal overflow/scrolling needed for core content
- [ ] Sidebar collapses/hidden on screens <768px

#### 768px Tablet
- [ ] Two-column layouts work (if applicable)
- [ ] Modal dialogs don't exceed 90vw width
- [ ] Gallery grid shows 2-3 cards per row
- [ ] Navigation still accessible (could show partial menu or hamburger)

#### 1024px+ Desktop
- [ ] Sidebar visible
- [ ] Multi-column layouts work
- [ ] Gallery shows 3+ cards per row
- [ ] Ambient selectors (None, Pink, White, Brown) don't wrap

---

### 2. Navigation & Menus

#### Hamburger Menu (Mobile <768px)
- [ ] Menu icon (≡) visible when not expanded
- [ ] Click expands menu smoothly
- [ ] Menu items stack vertically (NOT horizontally)
  - **CRITICAL FIX**: appNav display must be 'block', NOT 'flex'
  - Each .nav-item stacks in column
- [ ] Menu closes when item is clicked
- [ ] Menu dismisses on escape key
- [ ] Menu overlays don't cut off bottom navigation tabs

#### Desktop Navigation (1024px+)
- [ ] Sidebar permanently visible
- [ ] Menu items display horizontally or in left column
- [ ] Active tab highlighted
- [ ] No overflow

---

### 3. Core Tool Views (Pomodoro, Meditation, Breathing)

#### Timer Display (All Breakpoints)
- [ ] Large timer numbers visible without zoom (48px+)
- [ ] Timer display centered on screen
- [ ] Start/Stop buttons visible below timer
- [ ] Display doesn't flicker or jump when updating

#### Pomodoro Ambient Selector
- [ ] Ambient buttons visible at 480px width
  - [ ] Buttons stack if needed (don't wrap mid-row)
  - [ ] Each button has touch-friendly size (44px+ height)
- [ ] Selected ambient option highlighted
- [ ] Clicking ambient option swaps the sound
- [ ] No console errors when changing ambient

**480px Layout Test**:
```
⎕ Timer Display (large, centered)
⎕ [Start] [Stop] (stacked or side-by-side)
⎕ Ambient Options:
  ⎕ [None] [Pink] [White] [Brown]
  (If wrapping needed at this breakpoint)
⎕ Energy Rating (if after session)
```

#### Energy Rating Input (480px)
- [ ] Radio buttons spaced for touch (44px+ between options)
- [ ] Label text readable without zoom
- [ ] Submit button full width or centered
- [ ] Form doesn't cause horizontal scroll

#### Meditation View Specific
- [ ] Completion chime plays on stop (Web Audio API)
- [ ] Chime doesn't block UI (runs in background)
- [ ] Modal for meditation close/cancel is touch-friendly

#### Breathing View Specific
- [ ] Circle animation visible without scroll at 480px
- [ ] Circle scales appropriately for smaller screens
- [ ] Breathing pattern label readable

---

### 4. Ambient Sound Controls

#### Procedural Noise (White/Brown/Pink)
- [ ] Audio plays immediately after selection
- [ ] No errors in browser console
- [ ] Volume is balanced with binaural beats
- [ ] Users can hear audio on mobile (check browser autoplay policy)

#### File-Based Ambient (Rain, Forest, Cafe, Ocean)
- [ ] Files load from `/audio/{type}.mp3`
- [ ] Loading indicator visible if slow network
- [ ] Audio loops seamlessly
- [ ] Can switch between ambients without delay
- [ ] Volume balancing correct (0.08 ambient + 0.05 binaural)

#### Autoplay Restrictions (Mobile)
- [ ] On iOS: First user gesture required (click start button)
- [ ] If autoplay blocked, show unmute toast: "🔊 Tap to unmute audio"
- [ ] Unmute toast disappears after successful audio start

---

### 5. Gallery/Hero Section

#### Hero Display (380px target height)
- [ ] Hero section visible in viewport at 480px width
- [ ] Hero image/content doesn't hide core controls
- [ ] Hero text readable (heading 20px+, body 14px+)
- [ ] Call-to-action button clickable

#### Gallery Cards (Thumbnail Grid)
- [ ] Cards don't overlap at 480px
- [ ] Cards show 1 column on mobile, 2 on tablet, 3+ on desktop
- [ ] Card images scale proportionally
- [ ] Card titles/descriptions don't truncate awkwardly

---

### 6. Forms & Modals

#### Authentication Modal (480px)
- [ ] Modal width ≤ 90vw (leaves margin on edges)
- [ ] Input fields span full modal width (with padding)
- [ ] Labels visible above inputs
- [ ] Inputs have 44px+ height for touch
- [ ] Error messages display without overflow
- [ ] Toggle links ("Sign up" / "Sign in") clickable

#### Billing Modal
- [ ] "Enable Cloud Sync - $3/month" button visible
- [ ] Button width appropriate for 480px (not cramped)
- [ ] Stripe redirect URL doesn't get mangled
- [ ] Success redirect after Stripe checkout works

#### Generic Modal Improvements
- [ ] Close button (⨉) large enough to tap (24px+)
- [ ] Modal doesn't cover entire screen (leave 16px padding)
- [ ] Scrollable content inside modal if tall (≤ 80vh)

---

### 7. Settings & Utilities

#### Settings Panel
- [ ] All toggles/inputs visible without horizontal scroll
- [ ] Duration sliders work on touch (drag and tap)
- [ ] Numeric inputs accept touch keyboard
- [ ] Settings persist after page refresh

#### Dark Mode Toggle
- [ ] Toggle switch visible and functional
- [ ] Theme applies consistently across all views
- [ ] No flash of wrong theme on load (check localStorage usage)

#### Keyboard Shortcuts (if present)
- [ ] ?  shows help tooltip
- [ ] B, G, P shortcuts work on desktop
- [ ] On mobile, don't interfere with system keyboard

---

### 8. Cloud Sync & Billing (Responsive)

#### Cloud Sync Status Indicator
- [ ] Sync icon visible (show connected/disconnected state)
- [ ] Last sync time displays without truncation
- [ ] Sync button doesn't overflow on 480px

#### Subscription UI
- [ ] "Enable Cloud Sync" button visible at all breakpoints
- [ ] After subscribing, shows "Manage Subscription" instead
- [ ] Manage button links to Stripe portal safely
- [ ] Tier badge/indicator visible (if shown)

---

### 9. Console & Performance

#### No Errors at Any Breakpoint
- [ ] Open DevTools → Console
- [ ] Test each breakpoint: 320px, 480px, 768px, 1024px, 1920px
- [ ] No red error messages
- [ ] **Critical fixes**:
  - [ ] No "Unexpected token '}'" (showToast deletion bug)
  - [ ] No "Cannot read property '...' of undefined"
  - [ ] No "Missing ambient type" errors when selecting sounds

#### No Warnings
- [ ] No unhandled promise rejections
- [ ] No deprecated API warnings
- [ ] No layout shift warnings

#### Performance Metrics (480px Mobile)
- [ ] First Contentful Paint (FCP): < 2s
- [ ] Time to Interactive (TTI): < 4s
- [ ] Largest Contentful Paint (LCP): < 2.5s
- [ ] No Cumulative Layout Shift (CLS > 0.1)

---

### 10. Touch Interactions

#### All Interactive Elements
- [ ] Minimum 44x44px touch target
- [ ] Buttons spaced 16px+ apart (avoid fat-finger errors)
- [ ] No hover-only functionality
- [ ] Long-press works if needed (e.g., menu)

#### Scrolling Performance
- [ ] Lists/content scroll smoothly without jank
- [ ] Scroll performance remains at 60fps (use DevTools Profiler)
- [ ] Passive event listeners used (no scroll blocking)

#### Keyboard on Mobile
- [ ] Touch keyboard doesn't cover important UI
- [ ] Inputs auto-focus appropriately
- [ ] Form submission works with mobile keyboard (enter key)

---

## Responsive Typography Checklist

### Body Text
- [ ] 480px: 14px (readable without zoom)
- [ ] 768px: 14-15px
- [ ] 1024px: 15-16px
- [ ] Line height ≥ 1.5 for readability

### Headings
- [ ] H2: 20px (480px) → 28px (desktop)
- [ ] H3: 18px (480px) → 24px (desktop)
- [ ] No truncation with ...

### Call-to-Action Buttons
- [ ] Minimum 18px font
- [ ] Always readable without zoom

---

## Device Testing Checklist

### Real Device Testing (Recommended)
- [ ] iPhone 12 or newer (390px width)
- [ ] iPad (768px portrait, 1024px landscape)
- [ ] Android phone (360px width, 393px width)
- [ ] Landscape orientation on all devices

### Browser Emulation (Quick)
Chrome DevTools:
1. Press F12 → Click device icon
2. Select device from dropdown (or "Custom" for specific dimensions)
3. Enable slow CPU throttling (for realistic mobile battery performance)
4. Test with "Slow 3G" network (DevTools → Network → Throttling)

### Edge Cases to Test
- [ ] iPhone with notch/dynamic island
- [ ] Samsung with system navigation buttons
- [ ] iPad split-view (sidebar may shrink)
- [ ] Rotation changes (portrait ↔ landscape)

---

## Regression Testing (Post-Change)

After any layout or styling changes:

1. **Test all tool buttons**
   - [ ] Pomodoro, Meditation, Breathing still launch correctly
   - [ ] Ambient selectors still appear and change sound

2. **Test subscription flow**
   - [ ] "Enable Cloud Sync" button visible
   - [ ] Stripe redirect works (or test mode verification)

3. **Test forms**
   - [ ] Login modal responsive
   - [ ] Settings don't overflow
   - [ ] Error messages display properly

4. **High-priority breakpoints**
   - [ ] 480px (mobile critical)
   - [ ] 768px (tablet)
   - [ ] 1024px (desktop minimum)

---

## Browser Support Matrix

### Should Work
| Browser | Mobile | Tablet | Desktop |
|---------|--------|--------|---------|
| Chrome | 90+ | 90+ | 90+ |
| Safari iOS | 13+ | 13+ | N/A |
| Android Chrome | 90+ | 90+ | N/A |
| Firefox | 88+ | 88+ | 88+ |
| Edge | - | - | 90+ |

### Known Limitations
- [ ] Older iOS (<13): No Web Audio API
- [ ] IE 11: Not supported
- [ ] Opera mini: Reduced feature set (no Web Audio)

---

## Accessibility Mobile Considerations

- [ ] Touch targets ≥ 48px (44px absolute minimum)
- [ ] Color contrast: 4.5:1 for text on all breakpoints
- [ ] Form labels always visible (not placeholder-only)
- [ ] Focus indicators visible (for keyboard navigation)
- [ ] Avoid breakpoints where content becomes inaccessible

---

## Performance Optimization Reminders

### Mobile-Specific
- [ ] Lazy-load images (use loading="lazy" attribute)
- [ ] Minimize repaints/reflows (batch DOM updates)
- [ ] Use `passive: true` for scroll listeners
- [ ] Consider reducing animation complexity on low-end devices

### Check Before Deployment
- [ ] CSS file size < 50KB (gzipped)
- [ ] JS is minified
- [ ] No unused CSS (check Chrome coverage)
- [ ] Images optimized (use WebP with fallback)

---

## Testing Summary Table

| Area | 480px | 768px | 1024px | Notes |
|------|-------|-------|--------|-------|
| Navigation | Hamburger | Menu | Sidebar | Must not use flex on nav parent |
| Ambient | Stack if needed | 4 inline | 4 inline | All buttons touch-sized |
| Timer | Centered | Centered | Centered | 48px+ font |
| Energy | Spaced buttons | Radio row | Radio row | Touch targets 44px+ |
| Gallery | 1 column | 2 columns | 3+ columns | Cards scale responsively |
| Modal | 90vw | 600px | 600px | Never full-screen |
| Buttons | 48px touch target | 48px | 44px | Spacing between |

---

## Post-Testing Sign-Off

- [ ] All layout tests passed
- [ ] No console errors at any breakpoint
- [ ] Navigation works (hamburger on mobile, sidebar on desktop)
- [ ] All ambient selections functional
- [ ] Forms responsive and usable
- [ ] Billing flow doesn't break (Stripe integration)
- [ ] Tested on at least 2 real devices
- [ ] Performance acceptable on mobile (<4s TTI)
- [ ] No horizontal scroll on mobile (≤ 480px)
- [ ] Ready for production deployment
