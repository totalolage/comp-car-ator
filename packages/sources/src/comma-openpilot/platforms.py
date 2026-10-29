"""
Car names by platform from opendbc's car definitions, read by Python's own parser (`ast`), never
imported or run: the cross-check of the comma-openpilot Source's own reading (parsePlatforms).
Both read the same grammar (docs/adr/0016-openpilot-support.md) and fail on anything outside it.

  python3 -I platforms.py < {"constructors": [...], "carDocs": [...], "files": {url: source}}
  > {url: [[car name, platform], ...]}

A definition outside the grammar exits 1 with the reason on stderr.
"""

import ast
import json
import re
import sys

YEARS = re.compile(r"^(.+?) (\d{4}\S*(?:, \d{4}\S*)*)$")
PLATFORM = re.compile(r"^[A-Z][A-Z0-9_]*$")
FLAGS = (("hybrid", "Hybrid"), ("plug_in_hybrid", "Plug-in Hybrid"))


class Unreadable(Exception):
  pass


def identifiers(tree):
  """Every identifier the module spells, with the node spelling it."""
  for node in ast.walk(tree):
    if isinstance(node, ast.Name):
      yield node.id, node
    elif isinstance(node, ast.Attribute):
      yield node.attr, node
    elif isinstance(node, ast.keyword) and node.arg:
      yield node.arg, node
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
      yield node.name, node
    elif isinstance(node, ast.arg):
      yield node.arg, node
    elif isinstance(node, ast.alias):
      for part in node.name.split("."):
        yield part, node
      if node.asname:
        yield node.asname, node
    elif isinstance(node, (ast.Global, ast.Nonlocal)):
      for name in node.names:
        yield name, node
    elif isinstance(node, ast.ExceptHandler) and node.name:
      yield node.name, node
    elif getattr(node, "name", None).__class__ is str:  # match patterns, type parameters
      yield node.name, node


def binds(name, node):
  """Whether `node` binds `name` other than by a class statement or a plain import."""
  if isinstance(node, ast.Name):
    return not isinstance(node.ctx, ast.Load)
  if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.arg, ast.Global, ast.Nonlocal)):
    return True
  if isinstance(node, ast.alias):
    return node.asname == name
  if isinstance(node, ast.ClassDef):
    return False
  return not isinstance(node, (ast.Attribute, ast.keyword))


def read(source, constructors, car_docs):
  tree = ast.parse(source)
  spelled = list(identifiers(tree))

  # The platform class and the names that build it are opendbc's own, bound once.
  known = constructors | car_docs | {"CAR"}
  for name, node in spelled:
    if name in known and binds(name, node):
      raise Unreadable(f"{name} is bound in the file")
  for name in known:
    if sum(isinstance(n, ast.ClassDef) and n.name == name for _, n in spelled) > 1:
      raise Unreadable(f"class {name} twice")
  classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "CAR"]
  if len(classes) != 1:
    raise Unreadable("no platform class")
  cls = classes[0]
  bases = [b.id if isinstance(b, ast.Name) else None for b in cls.bases]
  if cls.decorator_list or cls.keywords or getattr(cls, "type_params", None) or bases != ["Platforms"]:
    raise Unreadable("class CAR is not `class CAR(Platforms):`")
  class_at = tree.body.index(cls)

  # Top-level `NAME = …` by name: where, its target and value; a name assigned twice is none.
  assigned = {}
  for at, stmt in enumerate(tree.body):
    if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
      target = stmt.targets[0]
    elif isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
      target = stmt.target
    else:
      continue
    if isinstance(target, ast.Name):
      name = target.id
      assigned[name] = None if name in assigned else (at, target, stmt.value)

  reads = {}  # read Name node -> name

  def named(expr, before):
    """The value of a name the file assigns once at its top level before `before`."""
    found = assigned.get(expr.id)
    if not found or found[0] >= before:
      raise Unreadable(f"{expr.id} is not assigned once at the top level before it is read")
    reads[expr] = expr.id
    return found

  def plain(call):
    if any(isinstance(a, ast.Starred) for a in call.args) or any(k.arg is None for k in call.keywords):
      raise Unreadable("* or ** arguments")
    names = [k.arg for k in call.keywords]
    if len(set(names)) != len(names):
      raise Unreadable("a keyword twice")
    return {k.arg: k.value for k in call.keywords}

  def car_list(expr, before):
    if isinstance(expr, ast.List):
      out = []
      for item in expr.elts:
        out += car_list(item.value, before) if isinstance(item, ast.Starred) else [car(item, before)]
      return out
    if isinstance(expr, ast.Name):
      at, _, value = named(expr, before)
      return car_list(value, at)
    raise Unreadable(f"cars are not a list (line {expr.lineno})")

  def car(expr, before):
    if isinstance(expr, ast.Call) and isinstance(expr.func, ast.Name) and expr.func.id in car_docs:
      keywords = plain(expr)
      first = expr.args[0] if expr.args else None
      if not (isinstance(first, ast.Constant) and isinstance(first.value, str)):
        raise Unreadable(f"a car name is not a string (line {expr.lineno})")
      names = [first.value]
      years = YEARS.match(first.value)
      for flag, word in FLAGS:
        if flag not in keywords:
          continue
        value = keywords[flag]
        if not (isinstance(value, ast.Constant) and isinstance(value.value, bool)):
          raise Unreadable(f"{flag} is not True or False (line {expr.lineno})")
        if value.value and years:
          names.append(f"{years[1]} {word} {years[2]}")
      return expr, names
    if isinstance(expr, ast.Name):
      at, _, value = named(expr, before)
      return car(value, at)
    raise Unreadable(f"a car is not a known CarDocs call (line {expr.lineno})")

  out = []
  platforms = set()
  for member in cls.body:
    if isinstance(member, ast.Pass) or (
      isinstance(member, ast.AnnAssign) and member.value is None and isinstance(member.target, ast.Name)
    ):
      continue
    if isinstance(member, ast.AnnAssign) and isinstance(member.target, ast.Name):
      target, call = member.target, member.value
    elif isinstance(member, ast.Assign) and len(member.targets) == 1 and isinstance(member.targets[0], ast.Name):
      target, call = member.targets[0], member.value
    else:
      raise Unreadable(f"unreadable member of class CAR (line {member.lineno})")
    platform = target.id
    if not PLATFORM.match(platform) or not isinstance(call, ast.Call):
      raise Unreadable(f"unreadable member of class CAR: {platform}")
    if platform in platforms:
      raise Unreadable(f"{platform} twice")
    platforms.add(platform)
    keywords = plain(call)
    func = call.func
    if isinstance(func, ast.Name) and func.id in constructors:
      if call.args and "car_docs" in keywords:
        raise Unreadable(f"cars of {platform} twice")
      cars = keywords.get("car_docs", call.args[0] if call.args else None)
    elif (
      isinstance(func, ast.Attribute)
      and func.attr == "override"
      and isinstance(func.value, ast.Name)
      and func.value.id in platforms - {platform}
      and not call.args
    ):
      cars = keywords.get("car_docs")
    else:
      raise Unreadable(f"{platform} is not built by a known platform config")
    if cars is None:
      raise Unreadable(f"no cars of {platform}")
    found = car_list(cars, class_at)
    # A car named elsewhere in the member is one the platform's cars do not hold.
    calls = {id(c) for c, _ in found}
    for node in ast.walk(member):
      if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and "CarDocs" in node.func.id
        and id(node) not in calls
      ):
        raise Unreadable(f"a car outside the cars of {platform}")
    out += [[name, platform] for _, names in found for name in names]

  # A name read for cars holds them as assigned only if nothing else uses it.
  for name in set(reads.values()):
    target = assigned[name][1]
    for spelled_name, node in spelled:
      if spelled_name == name and node is not target and node not in reads:
        raise Unreadable(f"cars under {name}, which the file uses elsewhere")
  return out


def main():
  given = json.load(sys.stdin)
  constructors, car_docs = set(given["constructors"]), set(given["carDocs"])
  out = {}
  for url, source in given["files"].items():
    try:
      out[url] = read(source, constructors, car_docs)
    except (Unreadable, SyntaxError) as e:
      sys.exit(f"{url}: {e}")
  json.dump(out, sys.stdout)


main()
