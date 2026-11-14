"""在 Blender 中建出 1:1 國道 (台北段)。

用法 (背景執行, 產生 .blend 與檢查用截圖):
  blender --background --factory-startup --python scripts/build_freeway_blender.py
在 Blender 內也可以直接用 Scripting 分頁執行本檔 (不會自動算圖)。

1 Blender 單位 = 1 公尺，座標為 TWD97 TM2 減去 meta.origin_twd97。
"""
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
DATA = os.path.join(ROOT, "data")
OUT_BLEND = os.path.join(ROOT, "blender", "taipei_freeway.blend")
OUT_RENDERS = os.path.join(ROOT, "renders")
LANE_W = 3.75
RENDER = bpy.app.background and "--no-render" not in sys.argv


# ================================================================ 工具
def build_mesh(name, V, F, uv=None, mat_idx=None, face_attrs=None):
    """V (n,3) float, F (m,4) int quads, uv (m*4,2) per loop."""
    me = bpy.data.meshes.new(name)
    V = np.ascontiguousarray(V, dtype=np.float32)
    F = np.ascontiguousarray(F, dtype=np.int32)
    me.vertices.add(len(V))
    me.vertices.foreach_set("co", V.ravel())
    me.loops.add(F.size)
    me.loops.foreach_set("vertex_index", F.ravel())
    me.polygons.add(len(F))
    me.polygons.foreach_set("loop_start", np.arange(0, F.size, 4, dtype=np.int32))
    try:
        me.polygons.foreach_set("loop_total", np.full(len(F), 4, dtype=np.int32))
    except (AttributeError, TypeError, RuntimeError):
        pass
    me.update(calc_edges=True)
    if uv is not None:
        lay = me.uv_layers.new(name="UVMap")
        lay.data.foreach_set("uv", np.ascontiguousarray(uv, dtype=np.float32).ravel())
    if mat_idx is not None:
        me.polygons.foreach_set("material_index", np.ascontiguousarray(mat_idx, dtype=np.int32))
    for k, arr in (face_attrs or {}).items():
        a = me.attributes.new(k, "FLOAT", "FACE")
        a.data.foreach_set("value", np.ascontiguousarray(arr, dtype=np.float32))
    me.validate(clean_customdata=False)
    return me


class Buf:
    """累積多段幾何後一次建 mesh。"""

    def __init__(self):
        self.V, self.F, self.UV, self.M = [], [], [], []
        self.A = {}
        self.n = 0

    def add(self, V, F, uv=None, mat=0, attrs=None):
        self.V.append(V)
        self.F.append(F + self.n)
        self.n += len(V)
        self.UV.append(uv if uv is not None else np.zeros((len(F) * 4, 2)))
        self.M.append(np.full(len(F), mat) if np.isscalar(mat) else mat)
        for k, v in (attrs or {}).items():
            self.A.setdefault(k, []).append(np.full(len(F), v))

    def mesh(self, name):
        if not self.V:
            return None
        return build_mesh(name, np.concatenate(self.V), np.concatenate(self.F),
                          np.concatenate(self.UV), np.concatenate(self.M),
                          {k: np.concatenate(v) for k, v in self.A.items()})


def link(obj, coll):
    coll.objects.link(obj)
    return obj


def new_coll(name, parent=None):
    c = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(c)
    return c


def strip_quads(n, a, b):
    """兩條各 n 點的頂點列 a, b (起始索引) 之間的四邊形。"""
    i = np.arange(n - 1)
    return np.stack([a + i, b + i, b + i + 1, a + i + 1], axis=1)


def frames(P):
    """沿線切線與左法向 (XY 平面)。"""
    d = np.empty_like(P[:, :2])
    d[1:-1] = P[2:, :2] - P[:-2, :2]
    d[0] = P[1, :2] - P[0, :2]
    d[-1] = P[-1, :2] - P[-2, :2]
    d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    nrm = np.c_[-d[:, 1], d[:, 0], np.zeros(len(d))]
    tan = np.c_[d, np.zeros(len(d))]
    return tan, nrm


# ================================================================ 材質
def sock(node, name, kind="inputs", typ=None):
    for s in getattr(node, kind):
        if s.name == name and (typ is None or s.type == typ) and getattr(s, "enabled", True):
            return s
    raise KeyError(f"{node.bl_idname}.{name}")


def new_material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    return m, nt, bsdf


def math_node(nt, op, a, b=None, c=None):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    for i, v in enumerate((a, b, c)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def mix_rgb(nt, fac, a, b):
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    if isinstance(fac, (int, float)):
        n.inputs[0].default_value = fac
    else:
        nt.links.new(fac, n.inputs[0])
    for name, v in (("A", a), ("B", b)):
        s = sock(n, name, typ="RGBA")
        if isinstance(v, tuple):
            s.default_value = v
        else:
            nt.links.new(v, s)
    return sock(n, "Result", "outputs", "RGBA")


def noise(nt, scale, detail=4.0):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nz = nt.nodes.new("ShaderNodeTexNoise")
    nz.inputs["Scale"].default_value = scale
    nz.inputs["Detail"].default_value = detail
    nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
    return nz.outputs["Fac"]


def mat_asphalt():
    m, nt, bsdf = new_material("瀝青路面_標線")
    uvn = nt.nodes.new("ShaderNodeUVMap")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(uvn.outputs["UV"], sep.inputs[0])
    u, v = sep.outputs[0], sep.outputs[1]
    a_ls = nt.nodes.new("ShaderNodeAttribute")
    a_ls.attribute_type = "GEOMETRY"
    a_ls.attribute_name = "ls"
    a_ln = nt.nodes.new("ShaderNodeAttribute")
    a_ln.attribute_type = "GEOMETRY"
    a_ln.attribute_name = "lanes"
    ls, lanes = a_ls.outputs["Fac"], a_ln.outputs["Fac"]

    k = math_node(nt, "DIVIDE", math_node(nt, "SUBTRACT", u, ls), LANE_W)    # 第幾條車道線
    kr = math_node(nt, "ROUND", k)
    dist = math_node(nt, "MULTIPLY", math_node(nt, "ABSOLUTE", math_node(nt, "SUBTRACT", k, kr)), LANE_W)
    on_line = math_node(nt, "LESS_THAN", dist, 0.075)                         # 線寬 15 cm
    is_left = math_node(nt, "COMPARE", kr, 0.0, 0.1)                          # 內側邊線 (黃)
    is_right = math_node(nt, "COMPARE", kr, lanes, 0.1)                       # 外側邊線 (白)
    inner = math_node(nt, "MULTIPLY", math_node(nt, "GREATER_THAN", kr, 0.5),
                      math_node(nt, "LESS_THAN", kr, math_node(nt, "SUBTRACT", lanes, 0.5)))
    dash = math_node(nt, "LESS_THAN", math_node(nt, "FRACT", math_node(nt, "DIVIDE", v, 10.0)), 0.4)  # 畫 4 m 空 6 m
    white = math_node(nt, "MULTIPLY", on_line,
                      math_node(nt, "MAXIMUM", is_right, math_node(nt, "MULTIPLY", inner, dash)))
    yellow = math_node(nt, "MULTIPLY", on_line, is_left)

    base = mix_rgb(nt, noise(nt, 0.8, 6.0), (0.035, 0.035, 0.037, 1), (0.075, 0.073, 0.07, 1))
    c1 = mix_rgb(nt, white, base, (0.8, 0.8, 0.78, 1))
    c2 = mix_rgb(nt, yellow, c1, (0.85, 0.6, 0.05, 1))
    nt.links.new(c2, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    return m


def mat_simple(name, color, rough=0.8, noise_amt=0.0):
    m, nt, bsdf = new_material(name)
    if noise_amt:
        dark = tuple(c * (1 - noise_amt) for c in color[:3]) + (1,)
        col = mix_rgb(nt, noise(nt, 0.3), dark, color)
        nt.links.new(col, bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = rough
    return m


def mat_barrier():
    """風化混凝土護欄 (與網頁版相同公式): 灰色斑駁、垂直雨痕、底部較髒、每 6 m 接縫、每 3 m 底部排水孔。"""
    m, nt, bsdf = new_material("混凝土護欄")
    uvn = nt.nodes.new("ShaderNodeUVMap")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(uvn.outputs["UV"], sep.inputs[0])
    u, v = sep.outputs[0], sep.outputs[1]

    def noise_at(x, y, z, scale_detail):
        cmb = nt.nodes.new("ShaderNodeCombineXYZ")
        for k_, val in enumerate((x, y, z)):
            if isinstance(val, (int, float)):
                cmb.inputs[k_].default_value = val
            else:
                nt.links.new(val, cmb.inputs[k_])
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 1.0
        nz.inputs["Detail"].default_value = scale_detail
        nt.links.new(cmb.outputs[0], nz.inputs["Vector"])
        return nz.outputs["Fac"]

    def smooth(x, e0, e1, out0, out1):
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.interpolation_type = "SMOOTHSTEP"
        mr.inputs["From Min"].default_value = e0
        mr.inputs["From Max"].default_value = e1
        mr.inputs["To Min"].default_value = out0
        mr.inputs["To Max"].default_value = out1
        nt.links.new(x, mr.inputs["Value"])
        return mr.outputs["Result"]

    n = noise_at(math_node(nt, "MULTIPLY", u, 0.9), math_node(nt, "MULTIPLY", v, 3.0), 0.0, 5.0)
    streak = noise_at(math_node(nt, "MULTIPLY", u, 6.0), math_node(nt, "MULTIPLY", v, 0.35), 1.7, 3.0)
    k = math_node(nt, "MULTIPLY_ADD", n, 0.35, 0.78)
    k = math_node(nt, "MULTIPLY", k, smooth(streak, 0.55, 0.8, 1.0, 0.72))            # 雨痕
    k = math_node(nt, "MULTIPLY", k, smooth(v, 0.0, 0.35, 0.62, 1.0))                 # 底部髒污
    jd = math_node(nt, "MULTIPLY", math_node(nt, "ABSOLUTE", math_node(nt, "SUBTRACT", math_node(nt, "FRACT", math_node(nt, "MULTIPLY_ADD", u, 1 / 6.0, 0.5)), 0.5)), 6.0)
    k = math_node(nt, "MULTIPLY", k, smooth(jd, 0.012, 0.03, 0.35, 1.0))              # 6 m 接縫
    dd = math_node(nt, "MULTIPLY", math_node(nt, "ABSOLUTE", math_node(nt, "SUBTRACT", math_node(nt, "FRACT", math_node(nt, "DIVIDE", u, 3.0)), 0.5)), 3.0)
    slot = math_node(nt, "MULTIPLY", math_node(nt, "LESS_THAN", dd, 0.15), smooth(v, 0.085, 0.1, 1.0, 0.0))   # 排水孔
    vm = nt.nodes.new("ShaderNodeVectorMath")
    vm.operation = "SCALE"
    vm.inputs[0].default_value = (0.18, 0.175, 0.165)
    nt.links.new(k, sock(vm, "Scale"))
    col = mix_rgb(nt, slot, vm.outputs[0], (0.01, 0.01, 0.01, 1))
    nt.links.new(col, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.92
    return m


def mat_emit(name, color):
    m, nt, bsdf = new_material(name)
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Emission Color"].default_value = color
    bsdf.inputs["Emission Strength"].default_value = 1.5
    return m


def mat_terrain():
    m, nt, bsdf = new_material("地形")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 15
    mr.inputs["From Max"].default_value = 90
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    n1 = noise(nt, 0.004, 5.0)
    low = mix_rgb(nt, n1, (0.055, 0.068, 0.045, 1), (0.075, 0.085, 0.06, 1))   # 盆地: 灰綠 (都市+綠地)
    high = mix_rgb(nt, n1, (0.016, 0.042, 0.014, 1), (0.032, 0.068, 0.024, 1))  # 山區: 闊葉林深綠
    nt.links.new(mix_rgb(nt, mr.outputs["Result"], low, high), bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    return m


# ================================================================ 幾何
# 混凝土護欄斷面 (照街景: 底部小斜趾、上半近乎垂直、平頂)，與網頁版相同
BARRIER = np.array([(-0.32, 0), (-0.3, 0.07), (-0.2, 0.16), (-0.11, 0.84), (-0.08, 0.87), (0.08, 0.87),
                    (0.11, 0.84), (0.2, 0.16), (0.3, 0.07), (0.32, 0)])
BARRIER_INSET = 0.35


def add_road(buf, w):
    P = np.array(w["pts"], dtype=np.float64)
    n = len(P)
    if n < 2:
        return None
    tan, nrm = frames(P)
    hw = w["width"] / 2
    L = P + nrm * hw
    R = P - nrm * hw
    seglen = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.r_[0, np.cumsum(seglen)]

    # 路面
    V = np.concatenate([L, R])
    F = strip_quads(n, 0, n)                         # L_i, R_i, R_i+1, L_i+1
    i = np.arange(n - 1)
    uv = np.stack([np.c_[np.zeros(n - 1), s[i]], np.c_[np.full(n - 1, w["width"]), s[i]],
                   np.c_[np.full(n - 1, w["width"]), s[i + 1]], np.c_[np.zeros(n - 1), s[i + 1]]],
                  axis=1).reshape(-1, 2)
    buf.add(V, F, uv, 0, {"ls": w["ls"], "lanes": w["lanes"]})

    # 側面/梁底 (橋 2.2 m 箱梁, 地面 2 m 路基)
    depth = 2.2 if w["bridge"] else (0.6 if w["tunnel"] else 2.0)
    dz = np.array([0, 0, depth])
    V = np.concatenate([L, R, L - dz, R - dz])
    mL, mR = np.array(w["edgeL"], bool), np.array(w["edgeR"], bool)
    keepL, keepR = ~(mL[:-1] | mL[1:]), ~(mR[:-1] | mR[1:])     # 路緣落在別條路面上就不做側牆
    Fs = [strip_quads(n, 0, 2 * n)[:, [0, 3, 2, 1]][keepL],   # 左側 L_i, L_i+1, Lb_i+1, Lb_i
          strip_quads(n, n, 3 * n)[keepR]]                     # 右側 R_i, Rb_i, Rb_i+1, R_i+1
    if w["bridge"]:
        Fs.append(strip_quads(n, 2 * n, 3 * n)[:, [0, 3, 2, 1]])  # 梁底
    F = np.concatenate(Fs)
    buf.add(V, F, None, 1, {"ls": 0, "lanes": 0})
    return P, tan, nrm, s


def add_barrier(buf, refl, P, nrm, edge_off, inward, mask=None, refl_mat=0):
    """edge_off: 邊線相對中心線的偏移 (左正右負)；inward: 往路內的方向；mask: 不放護欄的點。
    每個斷面線段各自一組頂點 (稜角分明)；UV: u = 沿線距離、v = 高度 (材質用來畫接縫、排水孔、髒污)。"""
    n = len(P)
    keep = np.ones(n - 1, bool) if mask is None else ~(mask[:-1] | mask[1:])
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))]
    c = P + nrm * (edge_off + inward * BARRIER_INSET)
    segs = len(BARRIER) - 1
    Vs, Fs, UVs = [], [], []
    base = 0
    for j in range(segs):
        prof = BARRIER[j:j + 2]                                    # 兩個斷面點
        V = (c[:, None, :] + nrm[:, None, :] * prof[None, :, 0, None]
             + np.array([0, 0, 1.0])[None, None, :] * (prof[None, :, 1, None] - 0.03)).reshape(-1, 3)
        i = np.arange(n - 1)
        a = base + i * 2
        F = np.stack([a, a + 1, a + 3, a + 2], axis=1)[keep]
        uvv = np.stack([np.c_[s[i], np.full(n - 1, prof[0, 1])], np.c_[s[i], np.full(n - 1, prof[1, 1])],
                        np.c_[s[i + 1], np.full(n - 1, prof[1, 1])], np.c_[s[i + 1], np.full(n - 1, prof[0, 1])]], axis=1)[keep]
        Vs.append(V); Fs.append(F); UVs.append(uvv.reshape(-1, 2))
        base += len(V)
    F = np.concatenate(Fs)
    if len(F):
        buf.add(np.concatenate(Vs), F, np.concatenate(UVs), 0)
    # 反光片: 每 24 m 一片 (外側紅、中央分隔黃)
    tan = np.c_[nrm[:, 1], -nrm[:, 0], np.zeros(n)]
    for d in np.arange(12, s[-1], 24.0):
        k = min(int(np.searchsorted(s, d)) - 1, n - 2)
        k = max(k, 0)
        if not keep[k]:
            continue
        t = (d - s[k]) / ((s[k + 1] - s[k]) or 1)
        p = c[k] + (c[k + 1] - c[k]) * t
        V, Fb = box(p[:2], tan[k], nrm[k], 0.05, 0.035, p[2] + 0.84, p[2] + 0.95)
        refl.add(V, Fb, None, refl_mat)


def box(center_xy, tan, nrm, hx, hy, z0, z1):
    c = np.array([center_xy[0], center_xy[1], 0.0])
    corners = []
    for z in (z0, z1):
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            corners.append(c + tan * sx * hx + nrm * sy * hy + np.array([0, 0, z]))
    V = np.array(corners)
    F = np.array([[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]])
    return V, F


def add_piers(buf, w, P, tan, nrm, s, spacing=35.0):
    under = np.array(w["under"])
    hw = w["width"] / 2
    count = 0
    for d in np.arange(spacing * 0.5, s[-1] - 5, spacing):
        k = int(np.searchsorted(s, d))
        k = min(max(k, 0), len(P) - 1)
        top = P[k, 2] - 2.2
        h = top - under[k]
        if h < 2.5:
            continue
        cap_h = 1.4
        V, F = box(P[k, :2], tan[k], nrm[k], 1.0, 1.25, under[k] - 1.0, top - cap_h)   # 柱
        buf.add(V, F, None, 0)
        V, F = box(P[k, :2], tan[k], nrm[k], 0.9, hw * 0.85, top - cap_h, top)          # 帽梁
        buf.add(V, F, None, 0)
        count += 1
    return count


def build_terrain(coll, mat):
    g = np.load(os.path.join(DATA, "terrain_grid.npz"))
    X, Y, Z = g["X"], g["Y"], g["Z"]
    H, W = Z.shape
    V = np.c_[X.ravel(), Y.ravel(), Z.ravel()]
    ii, jj = np.meshgrid(np.arange(H - 1), np.arange(W - 1), indexing="ij")
    a = (ii * W + jj).ravel()
    F = np.stack([a, a + 1, a + W + 1, a + W], axis=1)
    me = build_mesh("地形", V, F)
    me.materials.append(mat)
    if hasattr(me, "shade_smooth"):
        me.shade_smooth()
    return link(bpy.data.objects.new("地形", me), coll)


# ================================================================ 場景
def setup_world():
    sc = bpy.context.scene
    world = bpy.data.worlds.new("天空")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes.get("Background")
    sky = nt.nodes.new("ShaderNodeTexSky")
    for t in ("MULTIPLE_SCATTERING", "NISHITA", "SINGLE_SCATTERING", "HOSEK_WILKIE"):
        try:
            sky.sky_type = t
            break
        except TypeError:
            continue
    for attr, val in (("sun_disc", False), ("sun_elevation", math.radians(32)),
                      ("sun_rotation", math.radians(215)), ("altitude", 100.0)):
        if hasattr(sky, attr):
            try:
                setattr(sky, attr, val)
            except (TypeError, AttributeError):
                pass
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.12

    sun_data = bpy.data.lights.new("太陽", "SUN")
    sun_data.energy = 3.2
    sun_data.angle = math.radians(0.6)
    sun = bpy.data.objects.new("太陽", sun_data)
    sun.rotation_euler = (math.radians(58), 0, math.radians(215 - 180))
    sc.collection.objects.link(sun)


def setup_render():
    sc = bpy.context.scene
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    sc.render.resolution_x, sc.render.resolution_y = 1600, 900
    sc.render.resolution_percentage = 100
    try:
        sc.eevee.taa_render_samples = 32
    except AttributeError:
        pass
    sc.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in
                                                          sc.view_settings.bl_rna.properties["view_transform"].enum_items] \
        else sc.view_settings.view_transform


def add_camera(coll, name, loc, target, lens=35):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.clip_start = 0.5
    cd.clip_end = 80000
    cam = bpy.data.objects.new(name, cd)
    loc = Vector([float(v) for v in loc])
    target = Vector([float(v) for v in target])
    cam.location = loc
    direction = target - loc
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    coll.objects.link(cam)
    return cam


def main():
    prep = json.load(open(os.path.join(DATA, "freeway_prep.json"), encoding="utf-8"))
    ways = prep["ways"]
    sc = bpy.context.scene
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    sc["origin_twd97"] = prep["meta"]["origin_twd97"]
    sc["data_source"] = prep["meta"]["source"]

    m_asp = mat_asphalt()
    m_con = mat_simple("混凝土", (0.5, 0.49, 0.46, 1), 0.85, 0.25)
    m_bar = mat_barrier()
    m_reflR = mat_emit("反光片_紅", (0.75, 0.02, 0.02, 1))
    m_reflY = mat_emit("反光片_黃", (0.85, 0.55, 0.02, 1))
    m_ter = mat_terrain()

    c_root = new_coll("國道_台北段")
    c_road = new_coll("路面", c_root)
    c_str = new_coll("結構物", c_root)
    c_ter = new_coll("地形", c_root)
    c_cam = new_coll("攝影機", c_root)

    groups = {}
    bar, pier, refl = Buf(), Buf(), Buf()
    n_piers = 0
    geo = {}
    for w in ways:
        if w["highway"] == "motorway_link":
            g = "匝道"
        elif str(w["highway"]).startswith("trunk"):
            g = "快速道路" + ("匝道" if w["highway"].endswith("_link") else (w["ref"] or ""))
        else:
            g = f"國道{w['ref']}號" if w["ref"] and not w["ref"].endswith("甲") else f"國道{w['ref']}"
        buf = groups.setdefault(g, Buf())
        r = add_road(buf, w)
        if r is None:
            continue
        P, tan, nrm, s = r
        geo[w["id"]] = r
        hw = w["width"] / 2
        add_barrier(bar, refl, P, nrm, hw, -1, np.array(w["edgeL"], bool), 1)    # 左緣 (中央分隔，黃反光片)
        add_barrier(bar, refl, P, nrm, -hw, +1, np.array(w["edgeR"], bool), 0)   # 右緣 (紅反光片)

    # 橋墩 (前處理已避開下層道路；柱子偏移時帽梁延伸過去)
    for x, y, tx, ty, offL, zg, top, capL, capR in prep.get("piers", []):
        t3 = np.array([tx, ty, 0.0])
        n3 = np.array([-ty, tx, 0.0])
        c = np.array([x, y]) + n3[:2] * offL
        V, F = box(c, t3, n3, 1.0, 1.25, zg - 1.0, top - 1.4)
        pier.add(V, F, None, 0)
        mid = (capL + capR) / 2
        c = np.array([x, y]) + n3[:2] * mid
        V, F = box(c, t3, n3, 0.9, (capR - capL) / 2, top - 1.4, top)
        pier.add(V, F, None, 0)
        n_piers += 1

    for g, buf in sorted(groups.items()):
        me = buf.mesh(g)
        me.materials.append(m_asp)
        me.materials.append(m_con)
        link(bpy.data.objects.new(g, me), c_road)
    me = bar.mesh("混凝土護欄")
    me.materials.append(m_bar)
    link(bpy.data.objects.new("混凝土護欄", me), c_str)
    me = refl.mesh("反光片")
    if me:
        me.materials.append(m_reflR)
        me.materials.append(m_reflY)
        link(bpy.data.objects.new("反光片", me), c_str)
    me = pier.mesh("橋墩")
    if me:
        me.materials.append(m_con)
        link(bpy.data.objects.new("橋墩", me), c_str)
    build_terrain(c_ter, m_ter)
    print(f"roads: {len(ways)} ways in {len(groups)} groups, piers: {n_piers}")

    setup_world()
    setup_render()

    # ---- 檢查用攝影機
    def pick(pred, frac=0.5):
        best = None
        for w in ways:
            if pred(w):
                L = len(w["pts"])
                if best is None or L > len(best["pts"]):
                    best = w
        if best is None:
            return None
        P, tan, nrm, s = geo[best["id"]]
        k = int(len(P) * frac)
        return best, P[k], tan[k], nrm[k]

    cams = []
    cams.append(add_camera(c_cam, "CAM_全景", (2000, -15000, 5200), (2000, 2500, 0), 30))
    r = pick(lambda w: w["name"] == "汐止五股高架道路")
    if r:
        w, p, t, nr = r
        cams.append(add_camera(c_cam, "CAM_汐五高架", p + nr * 160 - t * 120 + np.array([0, 0, 55]), p, 30))
    r = pick(lambda w: w["bridge"] and w["ref"] == "3" and
             max(np.array(w["pts"])[:, 2] - np.array(w["under"])) > 30)
    if r:
        w, p, t, nr = r
        cams.append(add_camera(c_cam, "CAM_國3高橋", p + nr * 260 + t * 80 + np.array([0, 0, 25]), p, 35))
    r = pick(lambda w: w["ref"] == "3" and not w["bridge"] and not w["tunnel"] and w["highway"] == "motorway", 0.3)
    if r:
        w, p, t, nr = r
        lane_center = w["width"] / 2 - w["ls"] - 1.5 * LANE_W
        eye = p + nr * lane_center + np.array([0, 0, 1.5])
        cams.append(add_camera(c_cam, "CAM_國3行車視角", eye, eye + t * 120 - np.array([0, 0, 2.5]), 28))
    # 交流道: 匝道最密集處
    mids = np.array([geo[w["id"]][0][len(w["pts"]) // 2] for w in ways
                     if w["highway"] == "motorway_link" and w["id"] in geo])
    if len(mids):
        d = np.linalg.norm(mids[:, None, :2] - mids[None, :, :2], axis=2)
        c = mids[np.argmax((d < 500).sum(1))]
        cams.append(add_camera(c_cam, "CAM_系統交流道", c + np.array([420, -520, 380]), c, 30))
    sc.camera = cams[0]

    os.makedirs(os.path.dirname(OUT_BLEND), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, compress=True)
    print("saved", OUT_BLEND)

    if RENDER:
        os.makedirs(OUT_RENDERS, exist_ok=True)
        for cam in cams:
            sc.camera = cam
            sc.render.filepath = os.path.join(OUT_RENDERS, cam.name + ".png")
            bpy.ops.render.render(write_still=True)
            print("rendered", sc.render.filepath)
        sc.camera = cams[0]
        bpy.ops.wm.save_as_mainfile(filepath=OUT_BLEND, compress=True)


main()
