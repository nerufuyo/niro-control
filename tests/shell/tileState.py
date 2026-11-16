# Reads what `gdbus call … Eval` printed, `(true, '"{\"area\": …}"')`, and writes the JSON it carries, with the layout added: tileState.py <layout>
import ast, json, sys

raw = sys.stdin.read().strip()
start, end = raw.index("'") + 1, raw.rindex("'")
text = ast.literal_eval("'" + raw[start:end] + "'")     # the GVariant string: a JSON string
data = json.loads(json.loads(text))                      # that string is JSON of a string that is JSON
data["layout"] = sys.argv[1]
print(json.dumps(data))
