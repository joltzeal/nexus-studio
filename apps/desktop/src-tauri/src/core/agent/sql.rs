use rusqlite::Row;

use super::{AgentResult, invalid};

// SQLite integers are signed; keep the unsigned API contract at the SQL boundary.
pub(super) fn to_sql_i64(value: u64) -> AgentResult<i64> {
    i64::try_from(value).map_err(|_| invalid("Unsigned integer exceeds the SQLite integer range"))
}

pub(super) fn read_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

pub(super) fn read_optional_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;

    use super::*;
    use crate::core::agent::storage_error;

    #[test]
    fn unsigned_sql_integers_round_trip_without_changing_json() {
        let db = Connection::open_in_memory().unwrap();
        for value in [0, 1, u64::try_from(i64::MAX).unwrap()] {
            let saved = db
                .query_row("SELECT ?1", [to_sql_i64(value).unwrap()], |row| {
                    read_u64(row, 0)
                })
                .unwrap();
            assert_eq!(json!(saved).as_u64(), Some(value));
        }
    }

    #[test]
    fn unsigned_sql_writes_reject_values_above_the_signed_range() {
        for value in [u64::try_from(i64::MAX).unwrap() + 1, u64::MAX] {
            let error = to_sql_i64(value).unwrap_err();
            assert_eq!(error.code, "INVALID_REQUEST");
        }
    }

    #[test]
    fn optional_unsigned_sql_integers_preserve_null_and_maximum() {
        let db = Connection::open_in_memory().unwrap();
        for value in [None, Some(0), Some(u64::try_from(i64::MAX).unwrap())] {
            let saved = db
                .query_row(
                    "SELECT ?1",
                    [value.map(to_sql_i64).transpose().unwrap()],
                    |row| read_optional_u64(row, 0),
                )
                .unwrap();
            assert_eq!(saved, value);
        }
    }

    #[test]
    fn invalid_stored_unsigned_integers_return_storage_errors() {
        let db = Connection::open_in_memory().unwrap();
        for value in [-1, i64::MIN] {
            let error = db
                .query_row("SELECT ?1", [value], |row| read_u64(row, 0))
                .map_err(storage_error)
                .unwrap_err();
            assert_eq!(error.code, "UNAVAILABLE");
            let error = db
                .query_row("SELECT ?1", [value], |row| read_optional_u64(row, 0))
                .map_err(storage_error)
                .unwrap_err();
            assert_eq!(error.code, "UNAVAILABLE");
        }
        for query in ["SELECT 1.5", "SELECT '1'", "SELECT NULL"] {
            assert!(db.query_row(query, [], |row| read_u64(row, 0)).is_err());
        }
    }
}
