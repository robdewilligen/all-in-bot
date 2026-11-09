/** The calendar day `now` falls on in `timeZone`; daily gifts are counted per such day. */
export function dayOf(now: Temporal.Instant, timeZone: string): Temporal.PlainDate {
  return now.toZonedDateTimeISO(timeZone).toPlainDate();
}

/** The next midnight in `timeZone` after `now`, so a day can last 23 or 25 hours around DST. */
export function nextResetAfter(now: Temporal.Instant, timeZone: string): Temporal.Instant {
  return dayOf(now, timeZone).add({ days: 1 }).toZonedDateTime({ timeZone }).toInstant();
}
