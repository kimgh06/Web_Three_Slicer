// STUB (stage 16): tbb -> sequential. blocked_range2d(row_begin,row_end,col_begin,col_end) exposing
// rows()/cols() (each a blocked_range). FillLightning/Layer.cpp iterates range.rows()/range.cols()
// inside a parallel_for that the stub runs on the whole range in one shot (single-threaded port).
#pragma once
#include "blocked_range.h"
namespace tbb {
template<class RowValue, class ColValue = RowValue>
class blocked_range2d {
public:
    using row_range_type = blocked_range<RowValue>;
    using col_range_type = blocked_range<ColValue>;
    blocked_range2d(RowValue row_begin, RowValue row_end, ColValue col_begin, ColValue col_end)
        : m_rows(row_begin, row_end), m_cols(col_begin, col_end) {}
    const row_range_type& rows() const { return m_rows; }
    const col_range_type& cols() const { return m_cols; }
    bool empty() const { return m_rows.empty() || m_cols.empty(); }
private:
    row_range_type m_rows;
    col_range_type m_cols;
};
}
