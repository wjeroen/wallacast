package io.github.wjeroen.wallacast.watch;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.view.MotionEvent;
import android.view.View;

/**
 * A round (or, with text, pill-shaped) button with a Lucide icon from res/drawable (the icons
 * the Wallacast app uses), text, or an icon with a small label inside it (the "15" of the
 * 15-second skips). With setPlain(true) it draws no background, like the app's skip buttons.
 */
public class RoundButton extends View {
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ink = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF box = new RectF();
    private Drawable icon;
    private int iconRes;
    private String text;
    private String label;
    private float iconScale = 0.5f;
    private boolean plain;
    /** A thin ring around the button that fills clockwise from the top (the play button's progress) */
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF ringBox = new RectF();
    private float ringSpace;
    private float progress;

    public RoundButton(Context context) {
        super(context);
        setClickable(true);
        setFocusable(true);
        ink.setColor(0xFFF1F5F9);
        ink.setTextAlign(Paint.Align.CENTER);
        ink.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        fill.setColor(0xFF1E293B);
    }

    /** An icon from res/drawable, iconScale of the button's size, with an optional label inside. */
    public void setIcon(int resId, float iconScale, String label) {
        if (icon != null && resId == iconRes && iconScale == this.iconScale) return;
        iconRes = resId;
        Drawable d = getContext().getDrawable(resId);
        if (d != null) {
            d = d.mutate();
            d.setTint(ink.getColor());
        }
        this.icon = d;
        this.iconScale = iconScale;
        this.label = label;
        this.text = null;
        invalidate();
    }

    public void setText(String text) {
        this.text = text;
        this.icon = null;
        this.iconRes = 0;
        this.label = null;
        invalidate();
    }

    public void setPlain(boolean plain) {
        this.plain = plain;
        invalidate();
    }

    /** Leaves room for a progress ring of this width around the button, gap pixels out. */
    public void setRing(float width, float gap) {
        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeWidth(width);
        ring.setStrokeCap(Paint.Cap.ROUND);
        ring.setColor(0xFFFFFFFF);
        ringSpace = width + gap;
        invalidate();
    }

    /** 0 draws no ring, 0.99 and up a full one. */
    public void setProgress(float value) {
        float p = value >= 0.99f ? 1f : Math.max(0f, Math.min(1f, value));
        if (Math.abs(p - progress) < 0.001f) return;
        progress = p;
        invalidate();
    }

    public void setColors(int background, int foreground) {
        fill.setColor(background);
        ink.setColor(foreground);
        if (icon != null) icon.setTint(foreground);
        invalidate();
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_DOWN) setAlpha(0.6f);
        if (event.getAction() == MotionEvent.ACTION_UP || event.getAction() == MotionEvent.ACTION_CANCEL) setAlpha(isEnabled() ? 1f : 0.35f);
        return super.onTouchEvent(event);
    }

    @Override
    public void setEnabled(boolean enabled) {
        super.setEnabled(enabled);
        setAlpha(enabled ? 1f : 0.35f);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float w = getWidth(), h = getHeight();
        if (ringSpace > 0 && progress > 0) {
            float half = ring.getStrokeWidth() / 2f;
            ringBox.set(half, half, w - half, h - half);
            canvas.drawArc(ringBox, -90, 360 * progress, false, ring);
        }
        // The button itself sits inside the ring's room
        float in = ringSpace;
        float r = Math.min(w, h) / 2f - in;
        if (!plain) {
            box.set(in, in, w - in, h - in);
            canvas.drawRoundRect(box, r, r, fill);
        }
        float cx = w / 2f, cy = h / 2f;
        if (icon != null) {
            int half = Math.round((Math.min(w, h) - 2 * in) * iconScale / 2f);
            icon.setBounds(Math.round(cx) - half, Math.round(cy) - half, Math.round(cx) + half, Math.round(cy) + half);
            icon.draw(canvas);
            if (label != null) {
                ink.setTextSize(half * 0.62f);
                Paint.FontMetrics fm = ink.getFontMetrics();
                canvas.drawText(label, cx, cy - (fm.ascent + fm.descent) / 2f, ink);
            }
            return;
        }
        if (text != null) {
            ink.setTextSize(h * 0.36f);
            Paint.FontMetrics fm = ink.getFontMetrics();
            canvas.drawText(text, cx, cy - (fm.ascent + fm.descent) / 2f, ink);
        }
    }
}
