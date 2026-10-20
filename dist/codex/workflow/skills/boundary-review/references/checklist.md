# Boundary checklist

| Changed path | Prove with code and tests |
|---|---|
| Request, job, query, stream, export, attachment | Tenant and purpose verified before loading? Other accounts and missing context denied? Pooled state cleared after failure? |
| Roles, approvals, admin | Can a forged principal, stale membership or old approval bypass current authority? Is the exact diff bound to a valid proof? |
| Webhook or backfill | Raw body verified and stored durably before acknowledgement? Duplicates and reordered events converge? |
| Queue or remote effect | Can a crash lose intent or repeat an effect? Does unknown state keep its reservation? Outbox boundaries tested? |
| Money, results, billing | Exact units, versions, rounding and corrections preserved? Can the actor certify itself? |
| Models or data use | Can untrusted text alter tools, destinations or policy? Does withdrawal reach derived data? |
| Deployment or recovery | Revocations and deletions applied before access? Lost action identities reconciled before writes resume? |
