// The task that keeps Niro's face moving: it owns the screen while the face is shown, and gives it up for the static screens
// (the code entry, a notification's text). All calls may come from any task.
#pragma once
#include "face.h"

void face_task_start(void);
/** Takes the screen: the face is drawn from now on. */
void face_show(void);
/** Gives it up: returns once no frame is being drawn, so the caller may draw. */
void face_hide(void);
/** The expression, and a short line under it (at most 19 characters; NULL for none). */
void face_task_mood(face_mood_t mood, const char *caption);
/** Something happened: a sleepy face wakes. */
void face_task_poke(void);
