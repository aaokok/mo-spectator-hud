import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def run(command):
    result = subprocess.run(command, capture_output=True)
    if result.returncode:
        raise AssertionError(result.stdout.decode("utf-8", "replace") + result.stderr.decode("utf-8", "replace"))
    return result.stdout.decode("utf-8", "replace")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()
    source_dir = Path(__file__).resolve().parent
    source = (source_dir / "hud_bridge.c").read_text(encoding="utf-8-sig")
    work = args.work.resolve()
    work.mkdir(exist_ok=False)
    outcomes = []

    def check(name, data, valid=True):
        path = work / (name + ".ini")
        if data is not None:
            path.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
        result = subprocess.run([str(args.bridge.resolve()), "--check-unit-count-rules", str(path)], capture_output=True)
        assert (result.returncode == 0) == valid, (name, result.returncode, result.stdout, result.stderr)
        outcomes.append({"case": name, "pass": True, "returncode": result.returncode})

    prefix = "[meta]\nversion=1\n[units]\n"
    check("defaults", (source_dir / "unit_count_rules.default.ini").read_bytes())
    check("中文路径与注释", "\ufeff; 中文注释\n" + prefix + "dracod=ExClUdE_LoAdEd\n")
    check("empty_units", prefix)
    check("normal", prefix + "DRACOD=normal\n")
    check("future_id", prefix + "FUTURE_UNIT=exclude_all\n")
    check("invalid_policy", prefix + "DRACOD=exclude_loded\n", False)
    check("duplicate_id", prefix + "DRACOD=normal\ndracod=exclude_all\n", False)
    check("duplicate_section", prefix + "[units]\n", False)
    check("unknown_section", prefix + "[other]\n", False)
    check("unknown_meta", "[meta]\nversion=1\nother=1\n[units]\n", False)
    check("unsupported_version", "[meta]\nversion=2\n[units]\n", False)
    check("missing_units", "[meta]\nversion=1\n", False)
    check("missing_version", "[meta]\n[units]\n", False)
    check("invalid_utf8", b"[meta]\nversion=1\n[units]\n;\xff", False)
    check("embedded_nul", (prefix + "\0").encode(), False)
    check("invalid_id", prefix + "DRACO*=normal\n", False)
    check("long_id", prefix + "X" * 32 + "=normal\n", False)
    check("capacity_512", prefix + "".join(f"ID_{i}=normal\n" for i in range(512)))
    check("capacity_513", prefix + "".join(f"ID_{i}=normal\n" for i in range(513)), False)
    check("oversized", ";" + "x" * 65536, False)
    check("missing_file", None, False)
    missing_arg = subprocess.run([str(args.bridge.resolve()), "--check-unit-count-rules"], capture_output=True)
    assert missing_arg.returncode != 0
    outcomes.append({"case": "missing_argument", "pass": True})

    definitions = []
    for name in ["V_ITEMS", "V_COUNT", "UT_TYPE", "O_IS_ALIVE", "O_IN_LIMBO", "O_TRANSPORTER",
                 "O_OWNER", "O_HEALTH", "O_VETERANCY", "TY_SPAWNED", "T_ID"]:
        value = re.search(r"^#define\s+" + name + r"\s+(\S+)", source, re.MULTILINE).group(1)
        definitions.append("#define " + name + " " + value)
    begin = source.index("struct UnitAgg {")
    end = source.index("static int uagg_cmp(", begin)
    functions = source[begin:end]
    harness = r'''
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include "unit_count_rules.h"
static BYTE memory[0x20000];
static int rd_u8(DWORD p, BYTE *v) { *v=memory[p]; return 1; }
static int rd_u32(DWORD p, DWORD *v) { memcpy(v,memory+p,4); return 1; }
static int rd_i32(DWORD p, int *v) { memcpy(v,memory+p,4); return 1; }
static int rd_f32(DWORD p, float *v) { memcpy(v,memory+p,4); return 1; }
static int rd_str(DWORD p, char *v, int n) { lstrcpynA(v,(char *)memory+p,n); return 1; }
'''
    tests = r'''
static void put32(DWORD p,DWORD v) { memcpy(memory+p,&v,4); }
static int slots, scans;
static void reset(void) {
    memset(memory,0,sizeof(memory)); memset(g_uagg,0,sizeof(g_uagg));
    slots=g_uagg_n=g_uagg_dropped=g_uagg_skipped=0;
    put32(0x100+V_ITEMS,0x200); put32(0x300+V_ITEMS,0x400);
}
static void object(int air,const char *id,int alive,int limbo,DWORD carrier,int spawned,DWORD owner) {
    DWORD count=0,array=air?0x300:0x100,items=air?0x400:0x200;
    DWORD op=0x8000+slots*0x1000,type=0x2000+slots*0x1000;
    assert(slots++<6); rd_u32(array+V_COUNT,&count); put32(items+count*4,op);
    put32(array+V_COUNT,count+1); memory[op+O_IS_ALIVE]=(BYTE)alive;
    memory[op+O_IN_LIMBO]=(BYTE)limbo; put32(op+O_TRANSPORTER,carrier);
    put32(op+O_OWNER,owner); put32(op+UT_TYPE,type); put32(op+O_HEALTH,180);
    memory[type+TY_SPAWNED]=(BYTE)spawned; strcpy((char *)memory+type+T_ID,id);
}
static int count_for(const char *id) {
    int i; for(i=0;i<g_uagg_n;i++) if(!strcmp(g_uagg[i].id,id)) return g_uagg[i].count; return 0;
}
static void scan(void) {
    DWORD house=0x700;
    unit_scan_array(0x100,UT_TYPE,&house,1); unit_scan_array(0x300,UT_TYPE,&house,1); scans++;
}
static void config(const char *text) {
    char data[2048],error[256]; struct UnitCountTable table;
    assert(strlen(text)<sizeof(data)); strcpy(data,text);
    assert(unit_count_parse(data,(DWORD)strlen(data),&table,error,sizeof(error)));
    g_unit_count_rules=table;
}
static void save(const WCHAR *path,const char *text) {
    HANDLE file=CreateFileW(path,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    DWORD written; assert(file!=INVALID_HANDLE_VALUE);
    assert(WriteFile(file,text,(DWORD)strlen(text),&written,NULL));
    assert(written==strlen(text)); FlushFileBuffers(file); CloseHandle(file);
}
static void poll(void) { g_unit_count_last_poll=GetTickCount()-1000; unit_count_poll(); }
int main(void) {
    int check,i,alive,limbo,carrier,spawned,owner_ok,matrix=0,n,mode;
    char text[256];
    const char *ids[]={"DRACO","DRACOD","CARRIER","HORNET","ASW","LEVIA","SHRIKE","E1","ORCA","SALA_1"};
    WCHAR original_path[UCR_PATH_CAP]; char error[256]; struct UnitCountTable table;
    assert(unit_count_path(&check)); assert(!check);
    wcscpy(original_path,g_unit_count_path);
    assert(unit_count_load(&g_unit_count_rules,error,sizeof(error)));
    assert(g_unit_count_rules.count==8);

    for(i=0;i<10;i++) for(alive=0;alive<2;alive++) for(limbo=0;limbo<2;limbo++)
    for(carrier=0;carrier<2;carrier++) for(spawned=0;spawned<2;spawned++) for(owner_ok=0;owner_ok<2;owner_ok++) {
        int excluded=!strcmp(ids[i],"SALA_1") || (!strcmp(ids[i],"DRACOD")&&limbo&&carrier);
        int expected=alive&&(!limbo||carrier)&&!spawned&&owner_ok&&!excluded;
        reset(); object(0,ids[i],alive,limbo,carrier?0x18000:0,spawned,owner_ok?0x700:0x701);
        scan(); assert(count_for(ids[i])==expected); matrix++;
    }
    for(n=3;n<=4;n++) for(mode=0;mode<3;mode++) {
        reset(); object(0,"CARRIER",1,0,0,0,0x700);
        for(i=0;i<n;i++) object(1,"HORNET",1,mode==0||(mode==2&&i%2==0),0,1,0x700);
        scan(); assert(count_for("CARRIER")==1&&count_for("HORNET")==0);
    }
    reset(); object(0,"DRACO",1,0,0,0,0x700); object(0,"DRACO",1,0,0,0,0x700);
    object(0,"DRACOD",1,1,0x8000,0,0x700); object(0,"DRACOD",1,0,0,0,0x700);
    scan(); assert(count_for("DRACO")==2&&count_for("DRACOD")==1);
    reset(); object(0,"FV",1,0,0,0,0x700); object(0,"E1",1,1,0x8000,0,0x700);
    scan(); assert(count_for("FV")==1&&count_for("E1")==1);
    reset(); object(1,"ORCA",1,0,0,0,0x700); scan(); assert(count_for("ORCA")==1);
    reset(); object(0,"LEVI",1,0,0,0,0x700); object(1,"LEVIA",1,1,0,1,0x700);
    object(1,"LEVIA",1,0,0,1,0x700); scan(); assert(count_for("LEVI")==1&&count_for("LEVIA")==0);
    reset(); object(0,"DEST",1,0,0,0,0x700); object(1,"ASW",1,0,0,1,0x700);
    scan(); assert(count_for("DEST")==1&&count_for("ASW")==0);
    reset(); object(0,"DRACOD",1,0,0,0,0x700); scan(); assert(count_for("DRACOD")==1);
    reset(); object(0,"DRACOD",0,0,0,0,0x700); scan(); assert(count_for("DRACOD")==0);

    config("[meta]\nversion=1\n[units]\nDRACOD=normal\nHORNET=normal\n");
    reset(); object(0,"DRACOD",1,1,0x18000,0,0x700); object(1,"HORNET",1,0,0,1,0x700);
    scan(); assert(count_for("DRACOD")==1&&count_for("HORNET")==0);
    config("[meta]\nversion=1\n[units]\nDRACOD=exclude_all\n");
    reset(); object(0,"DRACOD",1,0,0,0,0x700); scan(); assert(count_for("DRACOD")==0);
    config("[meta]\nversion=1\n[units]\n");
    reset(); object(0,"SALA_1",1,1,0x18000,0,0x700); scan(); assert(count_for("SALA_1")==1);
    config("[meta]\nversion=1\n[units]\nE1=exclude_loaded\n");
    reset(); object(0,"E1",1,1,0x18000,0,0x700); object(0,"E1",1,0,0,0,0x700);
    scan(); assert(count_for("E1")==1);

    wcscat(g_unit_count_path,L".live");
    save(g_unit_count_path,"[meta]\nversion=1\n[units]\nDRACOD=exclude_loaded\n");
    unit_count_start(); assert(unit_count_excluded("DRACOD",1,1));
    save(g_unit_count_path,"[meta]\nversion=1\n[units]\nDRACOD=normal\n");
    poll(); assert(unit_count_excluded("DRACOD",1,1));
    poll(); assert(!unit_count_excluded("DRACOD",1,1));
    save(g_unit_count_path,"[meta]\nversion=1\n[units]\nDRACOD=broken\n");
    poll(); poll(); assert(!unit_count_excluded("DRACOD",1,1));
    assert(DeleteFileW(g_unit_count_path)); poll(); assert(!unit_count_excluded("DRACOD",1,1));
    save(g_unit_count_path,"[meta]\nversion=1\n[units]\nDRACOD=exclude_all\n");
    poll(); poll(); assert(unit_count_excluded("DRACOD",0,0));
    assert(DeleteFileW(g_unit_count_path)); unit_count_start();
    assert(unit_count_excluded("DRACOD",1,1)&&!unit_count_excluded("DRACOD",0,0));
    save(g_unit_count_path,"bad"); unit_count_start(); assert(g_unit_count_rules.count==8);
    assert(DeleteFileW(g_unit_count_path)); wcscpy(g_unit_count_path,original_path);
    assert(unit_count_load(&table,error,sizeof(error)));
    snprintf(text,sizeof(text),"{\"matrix\":%d,\"scans\":%d,\"hot_reload\":true,\"pass\":true}",matrix,scans);
    puts(text); return 0;
}
'''
    c_path = work / "test_rules.c"
    c_path.write_text(harness + "\n".join(definitions) + "\n" + functions + tests, encoding="utf-8")
    exe = work / "test_rules.exe"
    compile_output = run(["gcc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function",
                          "-O0", "-I", str(source_dir), str(c_path), "-o", str(exe), "-lshell32"])
    (work / "compile.log").write_text(compile_output, encoding="utf-8")
    runtime_config = work / "runtime.ini"
    runtime_config.write_bytes((source_dir / "unit_count_rules.default.ini").read_bytes())
    output = run([str(exe), "--unit-count-rules", str(runtime_config)])
    (work / "runtime.log").write_text(output, encoding="utf-8")
    summary = json.loads(output.strip().splitlines()[-1])
    results = {"config_checks": outcomes, "runtime": summary,
               "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
               "method": "Actual parser/reloader and current scanning functions with synthetic object memory; no game access"}
    (work / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"configuration_checks": len(outcomes), "runtime": summary}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
