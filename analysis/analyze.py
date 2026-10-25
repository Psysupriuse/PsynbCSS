"""V3.0 数据分析脚本：从课程提供的 V2.0 模拟运行数据中提取 docs/07 引用的统计结果。
数据来源：项目数据.zip 解压后的 data/*.csv（UTF-8 with BOM）。
用法：python analysis/analyze.py <data目录>
说明：该数据是教学构造样本，不是本组 V2.0 系统自动导出的日志（见 docs/07）。
"""
import csv
import io
import os
import sys
import collections


def load(base, name):
    with io.open(os.path.join(base, name), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def pct(n, d):
    return round(n / d * 100, 1) if d else 0.0


def main():
    base = sys.argv[1]
    reg = load(base, "registration_log.csv")
    act = {r["activity_id"]: r for r in load(base, "activity.csv")}
    wl = load(base, "waitlist_log.csv")
    beh = load(base, "user_behavior.csv")
    fb = load(base, "feedback.csv")
    logs = load(base, "system_log.csv")
    applies = [r for r in reg if r["action"] == "apply"]
    lines = []
    w = lines.append

    w("== 1. 报名请求结果（registration_log.csv，apply=%d，cancel=%d）" % (len(applies), len(reg) - len(applies)))
    res = collections.Counter(r["result"] for r in applies)
    for k in ("accepted", "waitlisted", "duplicate", "capacity_conflict", "server_error"):
        w("   %-18s %4d (%.1f%%)" % (k, res[k], pct(res[k], len(applies))))
    lat = sorted(int(r["latency_ms"]) for r in applies)
    w("   apply 耗时 p50=%dms p95=%dms max=%dms" % (lat[len(lat) // 2], lat[int(len(lat) * 0.95)], lat[-1]))
    by_res = collections.defaultdict(list)
    for r in applies:
        by_res[r["result"]].append(int(r["latency_ms"]))
    for k in ("accepted", "waitlisted", "capacity_conflict"):
        v = sorted(by_res[k])
        w("   %-18s p50=%dms p95=%dms" % (k, v[len(v) // 2], v[int(len(v) * 0.95)]))

    pairs = collections.Counter((r["student_id"], r["activity_id"]) for r in applies)
    dup = {k: v for k, v in pairs.items() if v > 1}
    w("== 2. 重复提交")
    w("   多次 apply 的组合 %d 组，多出的无效请求 %d 次（%.1f%%），客户端自报重试 %d 次"
      % (len(dup), sum(v - 1 for v in dup.values()), pct(sum(v - 1 for v in dup.values()), len(applies)),
         sum(1 for r in applies if r["client_retry"] == "1")))

    entered = collections.defaultdict(set)
    promoted = collections.defaultdict(set)
    for r in wl:
        if r["new_status"] == "waiting":
            entered[r["activity_id"]].add(r["student_id"])
        elif r["new_status"] == "accepted":
            promoted[r["activity_id"]].add(r["student_id"])
    total_in = sum(len(v) for v in entered.values())
    total_promo = sum(len(v) for v in promoted.values())
    w("== 3. 候补与递补（waitlist_log.csv）")
    w("   进入候补 %d，发生递补 %d（%.1f%%）" % (total_in, total_promo, pct(total_promo, total_in)))
    viewers = {(r["student_id"], r["activity_id"]) for r in beh if r["event_name"] == "status_view"}
    never = sum(1 for aid, sids in promoted.items() for s in sids if (s, aid) not in viewers)
    w("   递补成功但无 status_view 记录：%d / %d（%.1f%%）" % (never, total_promo, pct(never, total_promo)))
    w("   状态变化原因：%s" % dict(collections.Counter(r["reason_code"] for r in wl)))

    full = 0
    for aid, a in act.items():
        if sum(1 for r in applies if r["activity_id"] == aid and r["result"] == "accepted") >= int(a["capacity"]):
            full += 1
    caps = sorted(int(a["capacity"]) for a in act.values())
    w("== 4. 容量与满员（activity.csv，%d 个活动）" % len(act))
    w("   达到容量上限的活动 %d/%d（%.1f%%）；容量 min=%d 中位=%d max=%d"
      % (full, len(act), pct(full, len(act)), caps[0], caps[len(caps) // 2], caps[-1]))

    sess = collections.defaultdict(list)
    for r in beh:
        if r["page"]:
            sess[r["session_id"]].append(r)
    details = sorted(sum(1 for e in evs if e["page"] == "activity_detail") for evs in sess.values())
    reg_sess = [sum(1 for e in evs if e["page"] == "activity_detail") for evs in sess.values()
                if any(e["page"] == "registration" for e in evs)]
    devices = collections.Counter(r["device"] for r in beh)
    w("== 5. 用户行为（user_behavior.csv，%d 条，%d 个会话）" % (len(beh), len(sess)))
    w("   单会话打开详情页 p50=%d p90=%d max=%d" % (details[len(details) // 2], details[int(len(details) * 0.9)], details[-1]))
    if reg_sess:
        w("   到达报名页的会话 %d 个，此前平均打开详情 %.1f 次" % (len(reg_sess), sum(reg_sess) / len(reg_sess)))
    w("   设备：mobile=%d(%.1f%%) desktop=%d tablet=%d 空值=%d；重复 event_id=%d"
      % (devices["mobile"], pct(devices["mobile"], len(beh)), devices["desktop"], devices["tablet"],
         devices[""], len(beh) - len({r["event_id"] for r in beh})))

    w("== 6. 匿名反馈（feedback.csv，%d 条，%d 种表述）" % (len(fb), len({r["feedback_text"] for r in fb})))
    themes = {
        "候补/状态不可见": ["候补", "状态", "排队", "递补", "转成功"],
        "提交结果不确定/重复点击": ["失败", "重试", "点了两次", "转了一会儿", "提交成功", "卡住", "提示内容"],
        "查找筛选困难": ["查起来", "筛选", "逐个看", "一条条", "翻了几轮", "一类活动", "周末"],
        "标题信息不足": ["标题", "详情才知道", "地点说明"],
    }
    for name, kws in themes.items():
        n = sum(1 for r in fb if any(k in r["feedback_text"] for k in kws))
        w("   %-22s %d 条" % (name, n))

    levels = collections.Counter(r["level"] for r in logs)
    w("== 7. 系统日志（system_log.csv，%d 条）" % len(logs))
    w("   级别 %s；ERROR 事件码 %s；WARN 事件码 %s"
      % (dict(levels), dict(collections.Counter(r["event_code"] for r in logs if r["level"] == "ERROR")),
         dict(collections.Counter(r["event_code"] for r in logs if r["level"] == "WARN"))))

    text = "\n".join(lines)
    io.open("analysis/统计结果.txt", "w", encoding="utf-8").write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
