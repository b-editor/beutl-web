BEGIN {
  RS = ""
  found = 0
}

{
  block = tolower($0)
  if (block ~ /name:[[:space:]]*abort-incomplete-multipart-uploads/ &&
      block ~ /enabled:[[:space:]]*yes/ &&
      block ~ /action:[^\n]*abort incomplete multipart uploads after 7 days/) {
    found = 1
  }
}

END {
  exit(found ? 0 : 1)
}
