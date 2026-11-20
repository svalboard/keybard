"""When a board's reader tells it which app is in front (APP_FOREGROUND, app rules).

The board forgets the app 15 s after it last heard (the default lifetime), so the Host
says it again every RESEND seconds, and at once when another app comes to the front.
Pure timing: the clock is passed in, and nothing is sent here.
"""

RESEND = 5.0


class AppSender:
    def __init__(self):
        self.sent_id = None             # the last app ID the board accepted, None before the first
        self.tried_id = None            # the last app ID sent, accepted or not
        self.next_at = float('inf')     # when to say it again

    def due(self, app_id, now):
        """Whether to send app_id now. None (the app in front not known yet) sends nothing.
        An app the board just refused is tried again only at the next resend."""
        return app_id is not None and (app_id != self.tried_id or now >= self.next_at)

    def sent(self, app_id, now, accepted=True):
        self.tried_id, self.next_at = app_id, now + RESEND
        if accepted: self.sent_id = app_id
