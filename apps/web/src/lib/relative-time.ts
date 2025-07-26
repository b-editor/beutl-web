const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function getRelativeTimeDifference(targetDate: Date, now = new Date()) {
  const diffInMilliseconds = now.getTime() - targetDate.getTime();

  if (Math.abs(diffInMilliseconds) < 60_000) {
    const diffInSeconds = Math.floor(diffInMilliseconds / 1_000);
    return formatter.format(-diffInSeconds, "second");
  }
  if (Math.abs(diffInMilliseconds) < 3_600_000) {
    const diffInMinutes = Math.floor(diffInMilliseconds / 60_000);
    return formatter.format(-diffInMinutes, "minute");
  }
  if (Math.abs(diffInMilliseconds) < 86_400_000) {
    const diffInHours = Math.floor(diffInMilliseconds / 3_600_000);
    return formatter.format(-diffInHours, "hour");
  }

  const daysDifference = Math.floor(diffInMilliseconds / 86_400_000);
  if (Math.abs(daysDifference) < 30) {
    return formatter.format(-daysDifference, "day");
  }

  const monthsDifference = Math.floor(daysDifference / 30);
  if (Math.abs(monthsDifference) < 12) {
    return formatter.format(-monthsDifference, "month");
  }

  const yearsDifference = Math.floor(monthsDifference / 12);
  return formatter.format(-yearsDifference, "year");
}
