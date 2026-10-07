import sqlite3, shutil, sys, os
os.chdir(sys.argv[1])
for f in os.listdir('.'): os.remove(f)
b=sqlite3.connect('backup.db'); b.execute("create table t(x)"); b.execute("insert into t values('restored')"); b.commit(); b.close()
c=sqlite3.connect('memory.db'); c.execute("pragma journal_mode=wal"); c.execute("pragma wal_autocheckpoint=0")
c.execute("create table t(x)"); c.commit(); c.execute("insert into t values('stale-live')"); c.commit()
shutil.copy('memory.db-wal','wal.bak'); c.close()
shutil.copy('wal.bak','memory.db-wal')
shutil.copy('backup.db','memory.db')  # what restoreBackup does: overwrite main file only
d=sqlite3.connect('memory.db')
try: print(d.execute("select * from t").fetchall()); print(d.execute("pragma integrity_check").fetchall())
except Exception as e: print("ERR",e)
