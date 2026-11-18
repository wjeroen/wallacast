package io.github.wjeroen.wallacast.watch;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.view.MotionEvent;
import android.view.View;

/**
 * A round (or, with text, pill-shaped) button that draws its own symbol, so it looks the same
 * on every watch, without icon fonts or emoji.
 */
public class RoundButton extends View {
    public static final int PLAY = 1, PAUSE = 2, NEXT = 3, PREVIOUS = 4;

    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ink = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF box = new RectF();
    private int glyph;
    private String text;

    public RoundButton(Context context) {
        super(context);
        setClickable(true);
        setFocusable(true);
        ink.setColor(0xFFF1F5F9);
        ink.setTextAlign(Paint.Align.CENTER);
        ink.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        fill.setColor(0xFF1E293B);
    }

    public void setGlyph(int glyph) {
        this.glyph = glyph;
        this.text = null;
        invalidate();
    }

    public void setText(String text) {
        this.text = text;
        this.glyph = 0;
        invalidate();
    }

    public void setColors(int background, int foreground) {
        fill.setColor(background);
        ink.setColor(foreground);
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
        float r = Math.min(w, h) / 2f;
        box.set(0, 0, w, h);
        canvas.drawRoundRect(box, r, r, fill);
        float cx = w / 2f, cy = h / 2f, s = Math.min(w, h) * 0.22f;
        if (text != null) {
            ink.setTextSize(h * 0.36f);
            Paint.FontMetrics fm = ink.getFontMetrics();
            canvas.drawText(text, cx, cy - (fm.ascent + fm.descent) / 2f, ink);
            return;
        }
        Path p = new Path();
        switch (glyph) {
            case PLAY:
                p.moveTo(cx - s * 0.7f, cy - s);
                p.lineTo(cx + s, cy);
                p.lineTo(cx - s * 0.7f, cy + s);
                p.close();
                canvas.drawPath(p, ink);
                break;
            case PAUSE:
                canvas.drawRect(cx - s * 0.8f, cy - s, cx - s * 0.25f, cy + s, ink);
                canvas.drawRect(cx + s * 0.25f, cy - s, cx + s * 0.8f, cy + s, ink);
                break;
            case NEXT:
                p.moveTo(cx - s, cy - s);
                p.lineTo(cx + s * 0.5f, cy);
                p.lineTo(cx - s, cy + s);
                p.close();
                canvas.drawPath(p, ink);
                canvas.drawRect(cx + s * 0.55f, cy - s, cx + s, cy + s, ink);
                break;
            case PREVIOUS:
                p.moveTo(cx + s, cy - s);
                p.lineTo(cx - s * 0.5f, cy);
                p.lineTo(cx + s, cy + s);
                p.close();
                canvas.drawPath(p, ink);
                canvas.drawRect(cx - s, cy - s, cx - s * 0.55f, cy + s, ink);
                break;
            default:
                break;
        }
    }
}
