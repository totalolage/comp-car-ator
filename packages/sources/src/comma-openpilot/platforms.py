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

# opendbc's MODEL_YEARS_RE: where a car name's years start (docs_definitions.split_name).
YEARS = re.compile(r"(?<= )((\d{4}-\d{2})|(\d{4}))(,|$)")
PLATFORM = re.compile(r"^[A-Z][A-Z0-9_]*$")
FLAGS = (("hybrid", "Hybrid"), ("plug_in_hybrid", "Plug-in Hybrid"))
# The only imports that may bind a config or car class name.
IMPORTS = {("opendbc.car", "PlatformConfig"), ("opendbc.car.docs_definitions", "CarDocs")}
# Ways to reach or change objects without naming them: names, and attributes.
REFLECTION = {
  "setattr", "delattr", "getattr", "vars", "globals", "locals", "exec", "eval", "compile",
  "__import__", "__builtins__", "builtins", "importlib", "gc", "ctypes", "inspect",
}
FRAMES = {"_getframe", "f_locals", "f_globals", "f_back"}
SPECIAL = re.compile(r"^_.*_$")  # __dict__, __setattr__, an Enum's _value_


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
  if isinstance(node, (ast.alias, ast.ClassDef)):
    return False
  return not isinstance(node, (ast.Attribute, ast.keyword))


def hybrid_name(name, word):
  """The car Ford's configs add for a hybrid flag, as FordPlatformConfig.init names it."""
  if " " not in name:
    raise Unreadable(f"no make in car name {name!r}")
  make, model = name.split(" ", 1)
  years = ""
  match = YEARS.search(model)
  if match is not None:
    years = model[match.start():]
    model = model[:match.start() - 1]
  return f"{make} {model} {word} {years}"


def read(source, constructors, car_docs):
  tree = ast.parse(source)
  spelled = list(identifiers(tree))

  # The platform class and the names that build it are opendbc's own, bound once: by their
  # class statement or an import of opendbc's own.
  known = constructors | car_docs | {"CAR"}
  for name, node in spelled:
    if name in known and binds(name, node):
      raise Unreadable(f"{name} is bound in the file")
  defined = [n.name for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]
  for node in ast.walk(tree):
    if not isinstance(node, (ast.Import, ast.ImportFrom)):
      continue
    for alias in node.names:
      if alias.name == "*":
        raise Unreadable("import *")
      name = alias.asname or alias.name.split(".")[0]
      if name not in known:
        continue
      if not (
        isinstance(node, ast.ImportFrom)
        and not node.level
        and (node.module, alias.name) in IMPORTS
        and not alias.asname
      ):
        raise Unreadable(f"{name} is imported")
      defined.append(name)
  for name in known:
    if defined.count(name) > 1:
      raise Unreadable(f"{name} twice")
  classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "CAR"]
  if len(classes) != 1:
    raise Unreadable("no platform class")
  cls = classes[0]
  bases = [b.id if isinstance(b, ast.Name) else None for b in cls.bases]
  if cls.decorator_list or cls.keywords or getattr(cls, "type_params", None) or bases != ["Platforms"]:
    raise Unreadable("class CAR is not `class CAR(Platforms):`")
  class_at = tree.body.index(cls)

  # Python runs the file in order: each config and car class is bound by a top-level class
  # statement or import before class CAR, and before any code that calls it.
  bound_at = {}
  for at, stmt in enumerate(tree.body):
    if isinstance(stmt, ast.ClassDef):
      bound_at[stmt.name] = at
    elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
      for alias in stmt.names:
        bound_at[alias.asname or alias.name.split(".")[0]] = at
  for name in known - {"CAR"}:
    if name in defined and bound_at.get(name, class_at) >= class_at:
      raise Unreadable(f"{name} is not bound at the top level before class CAR")

  def bound_before(name, before):
    if bound_at.get(name, before) >= before:
      raise Unreadable(f"{name} is not bound before it is called")

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
      bound_before(expr.func.id, before)
      keywords = plain(expr)
      # A name and a package: a later argument may be a flag given by position.
      if len(expr.args) > 2:
        raise Unreadable(f"a car with more than two positional arguments (line {expr.lineno})")
      first = expr.args[0] if expr.args else None
      if not (isinstance(first, ast.Constant) and isinstance(first.value, str)):
        raise Unreadable(f"a car name is not a string (line {expr.lineno})")
      names = [first.value]
      for flag, word in FLAGS:
        if flag not in keywords:
          continue
        value = keywords[flag]
        if not (isinstance(value, ast.Constant) and isinstance(value.value, bool)):
          raise Unreadable(f"{flag} is not True or False (line {expr.lineno})")
        if value.value:
          names.append(hybrid_name(first.value, word))
      return expr, names
    if isinstance(expr, ast.Name):
      at, _, value = named(expr, before)
      return car(value, at)
    raise Unreadable(f"a car is not a known CarDocs call (line {expr.lineno})")

  out = []
  platforms = set()
  heads = set()  # the members' targets, and the platforms overrides name
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
    heads.add(target)
    platform = target.id
    if not PLATFORM.match(platform) or not isinstance(call, ast.Call):
      raise Unreadable(f"unreadable member of class CAR: {platform}")
    if platform in platforms:
      raise Unreadable(f"{platform} twice")
    platforms.add(platform)
    keywords = plain(call)
    func = call.func
    if isinstance(func, ast.Name) and func.id in constructors:
      bound_before(func.id, class_at)
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
      heads.add(func.value)
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

  # Nothing outside opendbc's own classes reaches the platforms to change them after they are
  # built: no assignment or `del` through CAR, a platform or a class above, or to an attribute
  # but a method's own (`self.STEER_MAX = …`); no `car_docs`; no reflection or special
  # attributes (`__dict__`, `_value_`) but `super().__init__`; a platform only as
  # `PLATFORM.<name>` (`.specs`).
  trusted = set()
  for node in ast.walk(tree):
    if isinstance(node, ast.ClassDef) and node.name in constructors | car_docs:
      trusted |= {id(n) for n in ast.walk(node)}
  parents = {id(child): node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
  guarded = known | platforms
  for node in ast.walk(tree):
    if id(node) in trusted:
      continue
    writes = isinstance(getattr(node, "ctx", None), (ast.Store, ast.Del)) and node not in heads
    if writes and any(isinstance(n, ast.Name) and n.id in guarded for n in ast.walk(node)):
      raise Unreadable(f"an assignment or del through a platform (line {node.lineno})")
    if writes and isinstance(node, ast.Attribute):
      own = isinstance(node.value, ast.Name) and node.value.id == "self"
      if not own or node.attr == "config" or SPECIAL.match(node.attr):
        raise Unreadable(f"an assignment or del of {node.attr} (line {node.lineno})")
    if isinstance(node, ast.Attribute):
      init = node.attr == "__init__" and isinstance(node.value, ast.Call) and getattr(node.value.func, "id", None) == "super"
      if node.attr in FRAMES | {"car_docs"} or (SPECIAL.match(node.attr) and not init):
        raise Unreadable(f"{node.attr} outside opendbc's classes (line {node.lineno})")
    if isinstance(node, ast.Name) and node.id in REFLECTION:
      raise Unreadable(f"{node.id} (line {node.lineno})")
    if isinstance(node, ast.Name) and node.id in platforms and node not in heads:
      if not isinstance(parents.get(id(node)), ast.Attribute):
        raise Unreadable(f"{node.id} other than as {node.id}.<name> (line {node.lineno})")

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
